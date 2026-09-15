import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, now } from "../core/store.mjs";
import { openAiGate, AiGateError } from "../ai/gate.mjs";
import { createModelRouter, recordModelUsage } from "../ai/router.mjs";

function withGate(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-ai-gate-"));
  try {
    const { db, audit } = openStore(dir);
    const calls = [];
    const fakeProvider = {
      id: "fake",
      async planLogin(params) {
        calls.push(params);
        return {
          plan: { title: "Login essentials", scenarios: ["valid_login"] },
          source: "fake",
          modelCalls: 1,
          usage: { model: "fake-model-v1", inputTokens: 3, outputTokens: 5 },
        };
      },
    };
    const modelRouter = createModelRouter({
      providers: { fake: fakeProvider },
      policy: { planLogin: { provider: "fake", model: "fake-model-v1" } },
    });
    const gate = openAiGate(db, audit, { modelRouter });
    return fn({ db, gate, calls });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRunAndRunbook(db, { source = "openai", startedAt = now() } = {}) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
    runbookId, 1, "lawcus", "t", "intent", source, JSON.stringify({ scenarios: [] }), now(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "passed", 0, startedAt);
  return { runId, runbookId };
}

test("AI is enabled by default", () => {
  withGate(({ gate }) => {
    assert.equal(gate.isEnabled(), true);
  });
});

test("setEnabled persists and isEnabled reflects it immediately", () => {
  withGate(({ gate }) => {
    gate.setEnabled(false, "operator:test");
    assert.equal(gate.isEnabled(), false);
    gate.setEnabled(true, "operator:test");
    assert.equal(gate.isEnabled(), true);
  });
});

test("setEnabled refuses a non-human or missing approver — the kill switch itself cannot be flipped by AI", () => {
  withGate(({ gate }) => {
    assert.throws(
      () => gate.setEnabled(false, "ai_planner"),
      (e) => e instanceof AiGateError && e.code === "non_human_approver",
    );
    assert.throws(
      () => gate.setEnabled(false, ""),
      (e) => e instanceof AiGateError && e.code === "no_approver",
    );
    assert.equal(gate.isEnabled(), true, "a refused toggle must not change anything");
  });
});

test("run() refuses cleanly when AI is disabled, and never calls the provider", () => {
  return withGate(async ({ gate, calls }) => {
    gate.setEnabled(false, "operator:test");
    await assert.rejects(
      gate.run("planLogin", { intent: "Do something no local pattern recognizes." }, { requester: "operator:test", reason: "no local match" }),
      (e) => e instanceof AiGateError && e.code === "ai_disabled",
    );
    assert.equal(calls.length, 0, "the fake provider must never have been reached");
  });
});

test("run() refuses an unregistered task category even when AI is enabled — no silent fallback to a provider call", () => {
  return withGate(async ({ gate, calls }) => {
    await assert.rejects(
      gate.run("someUnknownTask", {}, { requester: "operator:test", reason: "r" }),
      (e) => e instanceof AiGateError && e.code === "unknown_task",
    );
    assert.equal(calls.length, 0);
  });
});

test("run() requires a requester and a reason before doing anything else", () => {
  return withGate(async ({ gate }) => {
    await assert.rejects(
      gate.run("planLogin", {}, { reason: "r" }),
      (e) => e instanceof AiGateError && e.code === "no_requester",
    );
    await assert.rejects(
      gate.run("planLogin", {}, { requester: "operator:test" }),
      (e) => e instanceof AiGateError && e.code === "no_reason",
    );
  });
});

test("run() delegates to the real router when enabled and the task is known, and logs an allowed request", () => {
  return withGate(async ({ db, gate, calls }) => {
    const result = await gate.run("planLogin", { intent: "Test the login page thoroughly." }, { requester: "operator:test", reason: "no local match" });
    assert.equal(calls.length, 1);
    assert.equal(result.source, "fake");
    assert.ok(result.aiGateRequestId);
    const row = db.prepare("SELECT * FROM ai_gate_requests WHERE id=?").get(result.aiGateRequestId);
    assert.equal(row.allowed, 1);
    assert.equal(row.task, "planLogin");
    assert.equal(row.category, "AMBIGUITY_ANALYSIS");
    assert.equal(row.requester, "operator:test");
    assert.equal(row.runbook_id, null, "runbook doesn't exist yet at call time");
  });
});

test("finalizeRequest attaches runbook and model_usage ids independently, without clobbering the other", () => {
  return withGate(async ({ db, gate }) => {
    const result = await gate.run("planLogin", { intent: "x" }, { requester: "operator:test", reason: "r" });
    const { runbookId } = seedRunAndRunbook(db);
    const modelUsageId = recordModelUsage(db, { result, runbookId });
    assert.ok(modelUsageId);
    gate.finalizeRequest(result.aiGateRequestId, { runbookId });
    gate.finalizeRequest(result.aiGateRequestId, { modelUsageId });
    const row = db.prepare("SELECT * FROM ai_gate_requests WHERE id=?").get(result.aiGateRequestId);
    assert.equal(row.runbook_id, runbookId);
    assert.equal(row.model_usage_id, modelUsageId);
  });
});

test("usageSummary reports real counts — allowed vs blocked, tokens, and run-level AI usage", () => {
  return withGate(async ({ db, gate }) => {
    gate.setEnabled(false, "operator:test");
    await assert.rejects(gate.run("planLogin", {}, { requester: "operator:test", reason: "r" }));
    gate.setEnabled(true, "operator:test");
    const result = await gate.run("planLogin", { intent: "x" }, { requester: "operator:test", reason: "r" });
    const { runId, runbookId } = seedRunAndRunbook(db, { source: "openai" });
    const modelUsageId = recordModelUsage(db, { result, runbookId });
    gate.finalizeRequest(result.aiGateRequestId, { runbookId, modelUsageId });
    seedRunAndRunbook(db, { source: "built-in" }); // a non-AI run, must not count toward runsUsingAi

    const summary = gate.usageSummary();
    assert.equal(summary.aiEnabled, true);
    assert.equal(summary.totalRequests, 2);
    assert.equal(summary.allowedRequests, 1);
    assert.equal(summary.blockedRequests, 1);
    assert.equal(summary.inputTokens, 3);
    assert.equal(summary.outputTokens, 5);
    assert.equal(summary.byTask.planLogin, 2);
    assert.equal(summary.totalRuns, 2);
    assert.equal(summary.runsUsingAi, 1);
    assert.ok(summary.recent.some((r) => r.id === result.aiGateRequestId));
    void runId;
  });
});

test("usageSummary respects the sinceIso window — old requests fall outside it", () => {
  return withGate(async ({ gate }) => {
    gate.setEnabled(false, "operator:test");
    await assert.rejects(gate.run("planLogin", {}, { requester: "operator:test", reason: "r" }));
    const summary = gate.usageSummary({ sinceIso: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(summary.totalRequests, 0);
  });
});
