import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, now } from "../core/store.mjs";
import { createModelRouter, recordModelUsage, ModelRoutingError, TASK_POLICY } from "../ai/router.mjs";
import { createOpenAIProvider } from "../ai/providers/openai.mjs";

test("the production TASK_POLICY only routes the one task this app actually has, to the cheap tier", () => {
  assert.deepEqual(Object.keys(TASK_POLICY), ["planLogin"]);
  assert.equal(TASK_POLICY["planLogin"].provider, "openai");
  assert.equal(TASK_POLICY["planLogin"].model, "gpt-6-luna");
});

test("run() dispatches to whichever provider a policy names — swapping the provider under a policy key needs no router or call-site change", async () => {
  const calls = [];
  const fakeProvider = {
    id: "fake",
    async loginPlan(params, { model }) {
      calls.push({ params, model });
      return {
        plan: { title: "Login essentials", scenarios: ["valid_login"] },
        source: "fake",
        modelCalls: 1,
        usage: { model, inputTokens: 1, outputTokens: 2 },
      };
    },
  };
  const router = createModelRouter({
    providers: { fake: fakeProvider },
    policy: { "loginPlan": { provider: "fake", model: "fake-model-v1" } },
  });
  const result = await router.run("loginPlan", { intent: "Test the login page." });
  assert.equal(result.source, "fake");
  assert.equal(result.provider, "fake");
  assert.equal(result.task, "loginPlan");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "fake-model-v1");
});

test("run() fails closed for a task with no routing policy", async () => {
  const router = createModelRouter({ providers: {} });
  await assert.rejects(
    () => router.run("some-unknown-task", {}),
    (e) => e instanceof ModelRoutingError && e.code === "unknown_task",
  );
});

test("run() fails closed when the policy's provider isn't registered", async () => {
  const router = createModelRouter({ providers: {} }); // openai not registered
  await assert.rejects(
    () => router.run("planLogin", { intent: "Test the login page." }),
    (e) => e instanceof ModelRoutingError && e.code === "provider_not_registered",
  );
});

test("run() fails closed when the registered provider doesn't implement the task", async () => {
  const router = createModelRouter({ providers: { openai: { id: "openai" } } });
  await assert.rejects(
    () => router.run("planLogin", { intent: "Test the login page." }),
    (e) => e instanceof ModelRoutingError && e.code === "task_not_supported",
  );
});

test("run() against the real OpenAI provider still returns the same shape the old planWithAI did", async () => {
  const plan = { title: "Login essentials", scenarios: ["valid_login"], summary: "s", clarification: "" };
  const provider = createOpenAIProvider({
    getSecret: async () => "synthetic-api-key",
    request: async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
          usage: { input_tokens: 5, output_tokens: 7 },
        }),
        { status: 200 },
      ),
  });
  const router = createModelRouter({ providers: { openai: provider } });
  const result = await router.run("planLogin", { intent: "Test login" });
  assert.equal(result.source, "openai");
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(result.plan.scenarios, ["valid_login"]);
  assert.equal(result.usage.model, TASK_POLICY.planLogin.model);
  assert.equal(result.usage.inputTokens, 5);
});

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-ai-usage-"));
  try {
    const { db } = openStore(dir);
    return fn(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("recordModelUsage writes provider/model/purpose/tokens against the runbook once it exists", () => {
  withStore((db) => {
    const runbookId = randomUUID();
    db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
      runbookId, 1, "lawcus", "Login essentials", "Test login", "openai",
      '{"title":"Login essentials","scenarios":["valid_login"]}', now(),
    );
    recordModelUsage(db, {
      result: {
        provider: "openai",
        task: "planLogin",
        usage: { model: "gpt-4.1-mini", inputTokens: 12, outputTokens: 34 },
      },
      runbookId,
    });
    const row = db.prepare("SELECT * FROM model_usage WHERE runbook_id=?").get(runbookId);
    assert.equal(row.provider, "openai");
    assert.equal(row.model, "gpt-4.1-mini");
    assert.equal(row.purpose, "planLogin");
    assert.equal(row.input_tokens, 12);
    assert.equal(row.output_tokens, 34);
  });
});

test("recordModelUsage writes nothing when the result carries no usage (no model was actually called)", () => {
  withStore((db) => {
    const runbookId = randomUUID();
    db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
      runbookId, 1, "fixture", "Login essentials", "Test login", "intent-router",
      '{"title":"Login essentials","scenarios":["valid_login"]}', now(),
    );
    recordModelUsage(db, { result: { source: "intent-router", modelCalls: 0 }, runbookId });
    recordModelUsage(db, { result: undefined, runbookId });
    assert.equal(
      db.prepare("SELECT count(*) n FROM model_usage").get().n,
      0,
    );
  });
});
