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

test("an AI request is logged before the provider runs, and the linked ledger detects a changed row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ai-ledger-"));
  try {
    const { db, audit } = openStore(dir);
    const gate = openAiGate(db, audit, { modelRouter: { async run() {
      const pending = db.prepare("SELECT * FROM ai_gate_requests WHERE error_code='in_flight'").get();
      assert.ok(pending, "the provider call must have a durable starting record");
      assert.equal(db.prepare("SELECT phase FROM ai_decision_ledger WHERE gate_request_id=?").get(pending.id).phase, "started");
      return { provider: "fake", source: "fake", plan: { title: "Login essentials", scenarios: ["valid_login"] }, usage: { model: "fake", inputTokens: 1, outputTokens: 2 } };
    } } });
    const result = await gate.run("planLogin", { intent: "safe intent" }, { requester: "operator:test", reason: "test" });
    const ledger = db.prepare("SELECT * FROM ai_decision_ledger ORDER BY sequence").all();
    assert.deepEqual(ledger.map((r) => r.phase), ["started", "completed"]);
    assert.equal(ledger[1].previous_hash, ledger[0].entry_hash);
    assert.ok(!JSON.stringify(ledger).includes("safe intent"), "raw intent must not be kept in the ledger");
    assert.equal(gate.usageSummary().safety.ledger.intact, true);
    db.prepare("UPDATE ai_decision_ledger SET task='changed' WHERE sequence=?").run(ledger[0].sequence);
    await assert.rejects(
      gate.run("planLogin", { intent: "another" }, { requester: "operator:test", reason: "test" }),
      (e) => e instanceof AiGateError && e.code === "ledger_integrity",
    );
    assert.equal(gate.usageSummary().safety.circuit.circuit_open, 1);
    assert.equal(gate.usageSummary().safety.incidents[0].reason_code, "ledger_integrity");
    assert.throws(() => gate.setEnabled(true, "operator:test"), (e) => e.code === "ledger_integrity");
    assert.ok(result.aiGateRequestId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("three provider failures pause AI across gate instances; a human can reset it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ai-circuit-"));
  try {
    const { db, audit } = openStore(dir);
    let calls = 0;
    const router = { async run() { calls++; throw new Error("synthetic provider outage"); } };
    const gate = openAiGate(db, audit, { modelRouter: router });
    for (let i = 0; i < 3; i++)
      await assert.rejects(gate.run("planLogin", { intent: `failure ${i}` }, { requester: "operator:test", reason: "test" }), /synthetic provider outage/);
    const reopened = openAiGate(db, audit, { modelRouter: router });
    assert.equal(reopened.usageSummary().safety.circuit.circuit_open, 1);
    await assert.rejects(reopened.run("planLogin", { intent: "blocked" }, { requester: "operator:test", reason: "test" }), (e) => e.code === "circuit_open");
    assert.equal(calls, 3, "an open circuit never calls the provider");
    assert.equal(reopened.usageSummary().safety.incidents[0].status, "open");
    assert.throws(() => reopened.setEnabled(true, "ai_planner"), (e) => e.code === "non_human_approver");
    reopened.setEnabled(true, "operator:test");
    assert.equal(reopened.usageSummary().safety.circuit.circuit_open, 0);
    assert.equal(reopened.usageSummary().safety.incidents[0].closed_by, "operator:test");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsupported requests do not count as provider outages and malformed plans never become allowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ai-invalid-"));
  try {
    const { db, audit } = openStore(dir);
    let calls = 0;
    const gate = openAiGate(db, audit, { modelRouter: { async run() {
      calls++;
      if (calls <= 3) throw Object.assign(new Error("unsupported"), { code: "unsupported_request" });
      return { provider: "fake", plan: { title: "Login essentials", scenarios: ["invented_case"] } };
    } } });
    for (let i = 0; i < 3; i++) await assert.rejects(gate.run("planLogin", {}, { requester: "operator:test", reason: "test" }), /unsupported/);
    assert.equal(gate.usageSummary().safety.circuit.circuit_open, 0);
    await assert.rejects(gate.run("planLogin", {}, { requester: "operator:test", reason: "test" }), (e) => e.code === "invalid_model_output");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_gate_requests WHERE allowed=1").get().n, 0);
    assert.equal(db.prepare("SELECT error_code FROM ai_gate_requests ORDER BY rowid DESC LIMIT 1").get().error_code, "invalid_model_output");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hourly model budget blocks the next call, and a disabled operator switch survives migration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-ai-budget-"));
  try {
    const { db, audit } = openStore(dir);
    let calls = 0;
    const gate = openAiGate(db, audit, { modelRouter: { async run() {
      calls++;
      return { provider: "fake", plan: { title: "Login essentials", scenarios: ["valid_login"] }, usage: { model: "fake", inputTokens: 1, outputTokens: 1 } };
    } } });
    for (let i = 0; i < 20; i++) await gate.run("planLogin", { intent: `bounded ${i}` }, { requester: "operator:test", reason: "test" });
    await assert.rejects(gate.run("planLogin", { intent: "over budget" }, { requester: "operator:test", reason: "test" }), (e) => e.code === "request_budget");
    assert.equal(calls, 20);
    assert.equal(gate.usageSummary().safety.circuit.reason_code, "request_budget");
    gate.setEnabled(false, "operator:test");
    // Represent an existing v25 database with real Gate history and its own
    // persisted OFF setting, then apply migration 26 through normal startup.
    db.exec("DROP TABLE ai_decision_ledger; DROP TABLE ai_safety_incidents; DROP TABLE ai_residual_risks; DROP TABLE ai_safety_state");
    db.prepare("DELETE FROM schema_migrations WHERE version=26").run();
    const reopened = openStore(dir);
    assert.equal(openAiGate(reopened.db, reopened.audit, { modelRouter: { async run() { throw new Error("must not run"); } } }).isEnabled(), false);
    assert.equal(reopened.db.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 26);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
