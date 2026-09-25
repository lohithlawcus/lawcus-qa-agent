import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { classifyThrown, classifyReportedFailure, countByClass, FAILURE_CLASSES } from "../core/failure-class.mjs";
import { summarizeCells, finalizeRun } from "../core/run-outcome.mjs";
import { executeImpactedTest } from "../core/impacted-testing.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

const err = (message) => new Error(message);
const code = (e) => classifyThrown(e).reasonCode;
const cls = (e) => classifyThrown(e).failureClass;

// Messages copied from real failures seen in this project.
const LOGIN_TIMEOUT = "locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByPlaceholder('Search your practice', { exact: true }) to be visible";
const UI_TIMEOUT = "locator.fill: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByRole('dialog').locator('input[name=\"name\"]')";
const CLICK_BLOCKED = "locator.click: Timeout 35000ms exceeded.\nCall log:\n  - attempting click action\n    - <div> intercepts pointer events";

// ---------- thrown errors ----------

test("each known thrown error gets its own class and a stable reason code", () => {
  const table = [
    [LOGIN_TIMEOUT, "infrastructure", "login_timeout"],
    ["browserType.launch: Executable doesn't exist at /x/chromium", "infrastructure", "browser_unavailable"],
    ["page.goto: Target page, context or browser has been closed", "infrastructure", "browser_unavailable"],
    ["Live access (browser launch) is forbidden in this process.", "infrastructure", "live_access_forbidden"],
    ["Live access (Keychain) is forbidden in this process.", "infrastructure", "live_access_forbidden"],
    ["Invalid staging credentials.", "infrastructure", "credentials_unavailable"],
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://x", "infrastructure", "network_unreachable"],
    ["connect ECONNREFUSED 127.0.0.1:4320", "infrastructure", "network_unreachable"],
    ["page.goto: net::ERR_BLOCKED_BY_CLIENT at https://api.fiveriverz.com/v2/matters", "automation", "request_blocked_by_policy"],
    [UI_TIMEOUT, "automation", "ui_step_failed"],
    [CLICK_BLOCKED, "automation", "ui_step_failed"],
    ["locator.click: strict mode violation: getByRole('button') resolved to 2 elements", "automation", "ui_step_failed"],
    ["Could not determine the created matter's uuid from the post-save URL: /matters", "automation", "creation_unconfirmed"],
    ["The Client picker never offered \"QA Matter 1\" after 6 tries. nothing was selected.", "automation", "picker_option_missing"],
    ["page.waitForURL: Timeout 15000ms exceeded.", "automation", "ui_step_failed"],
    ["Timeout 5000ms exceeded while waiting for the event", "automation", "ui_step_timeout"],
  ];
  for (const [message, failureClass, reasonCode] of table) {
    assert.equal(cls(err(message)), failureClass, message.slice(0, 60));
    assert.equal(code(err(message)), reasonCode, message.slice(0, 60));
  }
});

test("a request blocked by our own policy is an automation problem, not a network outage (rule order)", () => {
  assert.equal(cls(err("net::ERR_BLOCKED_BY_CLIENT")), "automation");
  assert.equal(cls(err("net::ERR_CONNECTION_REFUSED")), "infrastructure");
});

test("a leftover-recording failure is an integrity problem even when the same message also reports an unconfirmed create", () => {
  const e = err("Could not determine the created contact's uuid from the post-save URL: /x (Also failed to record a possible leftover record: disk full)");
  assert.equal(cls(e), "integrity");
  assert.equal(code(e), "ownership_record_failed");
});

test("an error nobody has taught the classifier is 'unclassified' — never functional — and non-errors are tolerated", () => {
  for (const e of [err("something entirely new"), "just a string", undefined, null, {}]) {
    const c = classifyThrown(e);
    assert.equal(c.failureClass, "unclassified");
    assert.equal(c.reasonCode, "unclassified_error");
    assert.ok(c.explanation.length > 20);
  }
});

test("every classification carries a plain-English explanation and a known class", () => {
  for (const message of [LOGIN_TIMEOUT, UI_TIMEOUT, "ECONNRESET", "nope"]) {
    const c = classifyThrown(err(message));
    assert.ok(FAILURE_CLASSES.includes(c.failureClass));
    assert.ok(c.explanation.length > 20 && !/\[object/.test(c.explanation));
  }
});

// ---------- checks that finished and reported a failure ----------

test("a reported failure is functional unless its reason shows the environment was the problem", () => {
  const table = [
    ["The matter's detail page never showed the client's name.", "functional", "assertion_failed"],
    [undefined, "functional", "assertion_failed"],
    ["The contact was created, but its network request didn't match the approved create contract: Shape drift: missing uuid", "functional", "contract_mismatch"],
    ["The contact was created, but its network request didn't match the approved create contract: Unexpected status 500; expected one of 200.", "functional", "contract_mismatch"],
    ["The contact was created, but its network request didn't match the approved create contract: Unexpected status 503; expected one of 200.", "infrastructure", "staging_unavailable"],
    ["Unexpected status 502; expected one of 200.", "infrastructure", "staging_unavailable"],
    ["Unexpected status 429; expected one of 200.", "infrastructure", "rate_limited"],
  ];
  for (const [reason, failureClass, reasonCode] of table) {
    const c = classifyReportedFailure(reason);
    assert.equal(c.failureClass, failureClass, String(reason).slice(0, 60));
    assert.equal(c.reasonCode, reasonCode, String(reason).slice(0, 60));
  }
});

test("countByClass reads an unclassified-in-the-old-sense result (no class) as functional", () => {
  assert.deepEqual(countByClass([{ failureClass: "infrastructure" }, {}, { failureClass: null }, { failureClass: "bogus" }, { failureClass: "automation" }]), { infrastructure: 1, functional: 3, automation: 1 });
});

// ---------- the rollup ----------

const cell = (status, failureClass) => ({ executed: true, status, ...(failureClass !== undefined ? { failureClass } : {}) });

test("only a FUNCTIONAL failure fails a run; environment/tooling/automation failures leave it inconclusive", () => {
  const onlyInfra = summarizeCells([cell("passed"), cell("failed", "infrastructure")]);
  assert.equal(onlyInfra.outcome, "inconclusive");
  assert.equal(onlyInfra.status, "interrupted");
  assert.equal(onlyInfra.failed, 1, "the count of not-passed checks is unchanged");
  assert.match(onlyInfra.summary, /No check showed Lawcus behaving wrongly, but 1 of 2 executed check\(s\) could not complete \(1 could not run because of the environment or tooling\); 1 passed/);
  for (const failureClass of ["automation", "integrity", "unclassified"]) {
    assert.equal(summarizeCells([cell("failed", failureClass)]).outcome, "inconclusive", failureClass);
  }
  const mixed = summarizeCells([cell("failed", "functional"), cell("failed", "infrastructure"), cell("passed")]);
  assert.equal(mixed.outcome, "failed");
  assert.equal(mixed.status, "failed");
  assert.match(mixed.summary, /^1 of 3 executed check\(s\) failed; 1 could not run because of the environment or tooling\.$/);
});

test("results with no class (older callers) still fail the run exactly as before, and passing runs are unchanged", () => {
  assert.equal(summarizeCells([cell("failed")]).outcome, "failed");
  assert.equal(summarizeCells([cell("failed", null)]).outcome, "failed");
  assert.match(summarizeCells([cell("passed"), cell("failed")]).summary, /^1 of 2 executed check\(s\) failed\.$/);
  assert.equal(summarizeCells([cell("passed"), cell("passed")]).outcome, "passed");
  assert.equal(summarizeCells([]).outcome, "inconclusive");
});

// ---------- end to end through the executor ----------

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-failclass-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({ db, audit, testbook: openTestBook(db, audit) });
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
function registerCases(testbook, ids) {
  testbook.syncCases({
    featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d",
    entries: Object.fromEntries(ids.map((id) => [id, { source: `src-${id}`, definition: { id, name: id, layer: "both", risk: "normal", status: "approved" } }])),
  });
}
const planOf = (ids) => ({ cells: ids.map((id) => ({ featureName: "Contacts", recordState: "n/a", externalId: id, covered: true })) });

test("executeImpactedTest stores a class and code per failure, explains it first in the clarification, and the run comes out inconclusive", async () => {
  await withApp(async ({ db, audit, testbook }) => {
    const ids = ["c.ok", "c.login", "c.ui", "c.assert"];
    registerCases(testbook, ids);
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: planOf(ids), db, runId, testbook, delayBetweenRunsMs: 0, audit,
      runners: {
        "c.ok": async () => ({ passed: true, actual: "fine" }),
        "c.login": async () => { throw err(LOGIN_TIMEOUT); },
        "c.ui": async () => { throw err(UI_TIMEOUT); },
        "c.assert": async () => ({ passed: false, actual: "{}", reason: "The field showed the wrong value." }),
      },
    });
    const byId = Object.fromEntries(results.map((r) => [r.externalId, r]));
    assert.equal(byId["c.ok"].failureClass, null);
    assert.equal(byId["c.login"].failureClass, "infrastructure");
    assert.equal(byId["c.login"].reasonCode, "login_timeout");
    assert.equal(byId["c.login"].retried, true, "the existing single login retry still happens");
    assert.equal(byId["c.ui"].failureClass, "automation");
    assert.equal(byId["c.assert"].failureClass, "functional");
    const rows = db.prepare("SELECT scenario,status,failure_class,reason_code FROM scenario_results WHERE run_id=? ORDER BY scenario").all(runId);
    assert.deepEqual(rows.map((r) => [r.scenario, r.status, r.failure_class, r.reason_code]), [
      ["c.assert", "failed", "functional", "assertion_failed"],
      ["c.login", "failed", "infrastructure", "login_timeout"],
      ["c.ok", "passed", null, null],
      ["c.ui", "failed", "automation", "ui_step_failed"],
    ]);
    const questions = db.prepare("SELECT question FROM clarifications WHERE run_id=?").all(runId).map((r) => r.question);
    const loginQuestion = questions.find((q) => q.includes("login_timeout"));
    assert.match(loginQuestion, /^Signing in to staging never reached the workspace in time\..*\[infrastructure: login_timeout\] Execution error/s, "plain-English explanation first, technical detail after");

    // the run: one functional failure -> failed, and the summary says what else happened
    const verdict = finalizeRun(db, runId, { results });
    assert.equal(verdict.outcome, "failed");
    assert.equal(verdict.summary, "1 of 4 executed check(s) failed; 1 could not run because of the environment or tooling; 1 could not drive the page.");
  });
});

test("a run whose only failure is an infrastructure one is stored as inconclusive, never failed", async () => {
  await withApp(async ({ db, audit, testbook }) => {
    registerCases(testbook, ["c.ok", "c.login"]);
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: planOf(["c.ok", "c.login"]), db, runId, testbook, delayBetweenRunsMs: 0, audit,
      runners: { "c.ok": async () => ({ passed: true, actual: "fine" }), "c.login": async () => { throw err(LOGIN_TIMEOUT); } },
    });
    const verdict = finalizeRun(db, runId, { results });
    assert.equal(verdict.outcome, "inconclusive");
    const run = db.prepare("SELECT status,outcome,checks_failed,summary FROM runs WHERE id=?").get(runId);
    assert.equal(run.status, "interrupted");
    assert.equal(run.outcome, "inconclusive");
    assert.equal(run.checks_failed, 1);
    assert.match(run.summary, /nothing is claimed about the affected checks/);
  });
});

test("a crash summary names the class and code of the error that stopped the run", () => {
  withApp(({ db }) => {
    const runId = seedRun(db);
    finalizeRun(db, runId, { planned: 3, error: err("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x") });
    const run = db.prepare("SELECT status,outcome,summary FROM runs WHERE id=?").get(runId);
    assert.equal(run.outcome, "inconclusive");
    assert.match(run.summary, /Classified as infrastructure \(network_unreachable\): Staging could not be reached over the network\. No pass is claimed\./);
  });
});

test("the migration is recorded and the result columns exist with their check", () => {
  withApp(({ db }) => {
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=23").get());
    const columns = db.prepare("PRAGMA table_info(scenario_results)").all().map((c) => c.name);
    assert.ok(columns.includes("failure_class") && columns.includes("reason_code"));
    const runId = seedRun(db);
    const insert = (value) => db.prepare("INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,failure_class) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), runId, "s", "t", "failed", "e", "a", 1, value);
    assert.doesNotThrow(() => insert("automation"));
    assert.throws(() => insert("made_up_class"));
  });
});
