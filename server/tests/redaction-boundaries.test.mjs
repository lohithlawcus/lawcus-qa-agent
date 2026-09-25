import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { registerSecret, clearRegisteredSecrets } from "../core/redact.mjs";
import { executeImpactedTest } from "../core/impacted-testing.mjs";
import { finalizeRun } from "../core/run-outcome.mjs";
import { attachNetworkObserver } from "../core/network-observer.mjs";
import { captureScreenshot } from "../core/evidence.mjs";
import { createOpenAIProvider } from "../ai/providers/openai.mjs";
import { McpToolError } from "../mcp/tools.mjs";
import { textResult, errorResult } from "../mcp/results.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

// Made-up values only. PASSWORD is registered (as secrets.mjs does when it
// reads the Keychain); TYPED is never registered, so only patterns can catch it.
const PASSWORD = "Zx9!fake-Correct-Horse";
const TYPED = "unregistered-typed-Value-77";
const TOKEN = "tokFAKE1234567890abcdef";

test.beforeEach(() => { clearRegisteredSecrets(); registerSecret(PASSWORD); });
test.afterEach(() => clearRegisteredSecrets());

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-redaction-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({ db, audit, dir, testbook: openTestBook(db, audit) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "running", 0, new Date().toISOString());
  return runId;
}

function registerCase(testbook, id) {
  testbook.syncCases({
    featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d",
    entries: { [id]: { source: `src-${id}`, definition: { id, name: id, layer: "both", risk: "normal", status: "approved" } } },
  });
}

const allText = (db) =>
  JSON.stringify({
    results: db.prepare("SELECT actual, expected FROM scenario_results").all(),
    clarifications: db.prepare("SELECT question FROM clarifications").all(),
    runs: db.prepare("SELECT summary FROM runs").all(),
    audit: db.prepare("SELECT details FROM audit_events").all(),
  });

const noSecrets = (text, where) => {
  for (const s of [PASSWORD, TYPED, TOKEN]) assert.ok(!String(text).includes(s), `${where} leaked ${s}: ${String(text).slice(0, 300)}`);
};

// What Playwright really produced (verified empirically) when a fill() hits a
// read-only or disabled field: the typed value is inside the message.
const playwrightFillError = (value) =>
  new Error(`elementHandle.fill: Element is not editable\nCall log:\n  - fill("${value}")\n  - attempting fill action\n    - element is not editable`);

// ---------- audit trail ----------

test("audit events are stored masked: secret-named keys, labelled tokens and registered values", () => {
  withApp(({ db, audit }) => {
    audit("test.event", "e1", { password: TYPED, note: `Bearer ${TOKEN}`, nested: { token: TOKEN, list: [`see ${PASSWORD}`] }, scenario: "password_masked", ok: "fine" });
    const stored = db.prepare("SELECT details FROM audit_events WHERE action='test.event'").get().details;
    noSecrets(stored, "audit details");
    const parsed = JSON.parse(stored);
    assert.equal(parsed.ok, "fine");
    assert.equal(parsed.scenario, "password_masked", "a scenario NAME is not a secret");
  });
});

// ---------- stored and returned check results ----------

test("a failed fill() error carrying a typed value never reaches stored results, clarifications, the run summary or the returned results", async () => {
  await withApp(async ({ db, audit, testbook, dir }) => {
    registerCase(testbook, "r.registered");
    registerCase(testbook, "r.typed");
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: { cells: ["r.registered", "r.typed"].map((id) => ({ featureName: "Contacts", recordState: "n/a", externalId: id, covered: true })) },
      db, runId, testbook, delayBetweenRunsMs: 0, audit, artifactDirectory: join(dir, "artifacts"),
      runners: {
        "r.registered": async () => { throw playwrightFillError(PASSWORD); },
        "r.typed": async () => { throw playwrightFillError(TYPED); },
      },
    });
    assert.deepEqual(results.map((r) => r.status), ["failed", "failed"]);
    noSecrets(JSON.stringify(results), "returned results");
    finalizeRun(db, runId, { results });
    noSecrets(allText(db), "stored data");
    assert.match(results[0].actual, /Execution error: elementHandle\.fill: Element is not editable/, "the useful part of the message survives");
  });
});

test("a check that RETURNS text with a secret in it (actual / reason) is masked too", async () => {
  await withApp(async ({ db, testbook }) => {
    registerCase(testbook, "o.case");
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: { cells: [{ featureName: "Contacts", recordState: "n/a", externalId: "o.case", covered: true }] },
      db, runId, testbook, delayBetweenRunsMs: 0,
      runners: { "o.case": async () => ({ passed: false, actual: `field read ${PASSWORD}`, reason: `expected token=${TOKEN} but got ${PASSWORD}` }) },
    });
    noSecrets(JSON.stringify(results), "returned results");
    noSecrets(allText(db), "stored data");
  });
});

test("a crash summary never carries the crashing error's secrets", () => {
  withApp(({ db }) => {
    const runId = seedRun(db);
    finalizeRun(db, runId, { planned: 2, error: playwrightFillError(TYPED) });
    finalizeRun(db, seedRun(db), { planned: 1, error: new Error(`login failed with ${PASSWORD}`) });
    noSecrets(allText(db), "run summaries");
  });
});

// ---------- MCP output ----------

test("MCP error results are masked — for tool errors and for unexpected errors", () => {
  const unexpected = errorResult(playwrightFillError(PASSWORD)).content[0].text;
  noSecrets(unexpected, "MCP internal_error");
  assert.match(unexpected, /internal_error/);
  const tool = errorResult(new McpToolError("not_runnable", `bad input password=${TYPED}`)).content[0].text;
  noSecrets(tool, "MCP tool error");
  assert.match(tool, /not_runnable/);
});

test("MCP success results are masked in their values but keep legitimate key names", () => {
  const out = textResult({ runId: "r1", results: [{ actual: `Execution error: ${PASSWORD}` }], contract: { authorization: ["X-Header-Name"], note: `Bearer ${TOKEN}` } }).content[0].text;
  noSecrets(out, "MCP result");
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.contract.authorization, ["X-Header-Name"], "a metadata field that happens to be named like a secret survives");
  assert.equal(parsed.runId, "r1");
});

// ---------- captured page output ----------

test("console and page-error text captured from the browser is masked before it is kept", () => {
  const handlers = {};
  const context = { on: (event, fn) => { handlers[event] = fn; }, off: () => {} };
  const observer = attachNetworkObserver(context);
  handlers.console({ type: () => "error", text: () => `Failed to fetch https://api.test/x?access_token=${TOKEN} for ${PASSWORD}` });
  handlers.weberror({ error: () => new Error(`page crashed: Authorization: Bearer ${TOKEN}`) });
  assert.equal(observer.consoleEntries.length, 2);
  noSecrets(JSON.stringify(observer.consoleEntries), "console entries");
  assert.match(observer.consoleEntries[0].message, /Failed to fetch/);
  observer.dispose();
});

// ---------- model prompts ----------

test("the model-prompt guard rejects a typed secret even with no label, and does not block a normal request", async () => {
  const provider = createOpenAIProvider({
    getSecret: async () => { throw new Error("SENTINEL: the API key was read"); },
    request: async () => { throw new Error("SENTINEL: the network was called"); },
  });
  await assert.rejects(provider.planLogin({ intent: `log in using ${PASSWORD} please` }, { model: "m" }), /Remove credentials from the test instruction/);
  await assert.rejects(provider.planLogin({ intent: `password: ${TYPED}` }, { model: "m" }), /Remove credentials from the test instruction/);
  await assert.rejects(provider.planLogin({ intent: "Thoroughly test login." }, { model: "m" }), /SENTINEL: the API key was read/, "a normal request gets past the guard");
});

// ---------- evidence screenshots ----------

test("evidence screenshots mask password inputs and report null instead of throwing", async () => {
  let options;
  const page = { locator: (selector) => ({ selector }), screenshot: async (o) => { options = o; return Buffer.from("png"); } };
  assert.equal((await captureScreenshot(page)).toString(), "png");
  assert.deepEqual(options.mask, [{ selector: 'input[type="password"]' }]);
  const broken = { locator: () => ({}), screenshot: async () => { throw new Error("page closed"); } };
  assert.equal(await captureScreenshot(broken), null);
});

// ---------- wiring that cannot be exercised without a Keychain / HTTP server ----------

test("secrets.mjs registers every secret it reads or saves; the HTTP layer masks error bodies", () => {
  const secrets = readFileSync(new URL("../core/secrets.mjs", import.meta.url), "utf8");
  assert.match(secrets, /if\(operation==='set'\)noteKeychainValue\(value\)/, "a saved value must be registered");
  assert.match(secrets, /if\(operation==='get'&&result\?\.exists\)noteKeychainValue\(result\.value\)/, "a read value must be registered");
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(index, /status >= 400 \? sanitizeErrorBody\(data\) : data/, "error bodies must be sanitized in json()");
  const mcp = readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  assert.match(mcp, /from "\.\/results\.mjs"/, "the MCP server must shape results through results.mjs");
});
