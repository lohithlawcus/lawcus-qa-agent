import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { classifyLoginFailure, CheckAssertionError, classifyThrown } from "../core/failure-class.mjs";
import { finalizeFromSavedResults } from "../core/run-outcome.mjs";
import { runLive } from "../core/live-runner.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

const PAGE = {}; // a page exists
const classify = (over) => classifyLoginFailure({ error: new Error("x"), page: PAGE, loginStatus: undefined, scenario: "valid_login", authenticationBlocked: false, loginRequests: 0, ...over });

// ---------- the login suite's classification ----------

test("no isolated session -> the browser was the problem", () => {
  const c = classify({ page: undefined });
  assert.deepEqual([c.failureClass, c.reasonCode], ["infrastructure", "browser_unavailable"]);
});

test("staging rejecting the saved account (401/403) is a credentials problem, not a Lawcus failure", () => {
  for (const loginStatus of [401, 403]) {
    for (const scenario of ["valid_login", "logout"]) {
      const c = classify({ loginStatus, scenario });
      assert.deepEqual([c.failureClass, c.reasonCode], ["infrastructure", "credentials_rejected"], `${loginStatus} ${scenario}`);
    }
  }
});

test("the incorrect-password check EXPECTS a 401, so a failure there is judged on its own error, not as a rejected account", () => {
  const behavioural = classify({ scenario: "invalid_password", loginStatus: 401, error: new CheckAssertionError("Protected content remained accessible.") });
  assert.deepEqual([behavioural.failureClass, behavioural.reasonCode], ["functional", "assertion_failed"]);
  const timeout = classify({ scenario: "invalid_password", loginStatus: 403, error: new Error("locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByRole('alert')") });
  assert.equal(timeout.failureClass, "automation");
});

test("a check skipped because an earlier login failed is not a result about Lawcus", () => {
  const skipped = classify({ authenticationBlocked: true, loginRequests: 0, scenario: "valid_login" });
  assert.deepEqual([skipped.failureClass, skipped.reasonCode], ["infrastructure", "skipped_after_login_failure"]);
  // The same situation for a scenario that throws the 'earlier attempt failed' error is caught by its message.
  const viaMessage = classify({ scenario: "invalid_password", error: new Error("An earlier authentication attempt failed; additional attempts are stopped.") });
  assert.equal(viaMessage.reasonCode, "skipped_after_login_failure");
  // But a blocked flag with an actual login request in this scenario does not hide its own error.
  assert.notEqual(classify({ authenticationBlocked: true, loginRequests: 1 }).reasonCode, "skipped_after_login_failure");
  assert.notEqual(classify({ authenticationBlocked: true, loginRequests: 0, scenario: "empty_fields" }).reasonCode, "skipped_after_login_failure");
});

test("a check that RAN and saw wrong behavior is functional; environment and page problems are not", () => {
  for (const message of [
    "The password is not masked.", "Empty credentials were submitted or no validation was observed.", "The API did not explicitly reject the credentials.",
    "Protected content remained accessible.", "The test browser remained authenticated after logout.",
  ]) {
    const c = classify({ error: new CheckAssertionError(message) });
    assert.deepEqual([c.failureClass, c.reasonCode], ["functional", "assertion_failed"], message);
  }
  const table = [
    ["locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByPlaceholder('Search your practice', { exact: true }) to be visible", "infrastructure", "login_timeout"],
    ["page.goto: Timeout 25000ms exceeded.\nCall log:\n  - navigating to \"https://x/login\"", "infrastructure", "page_load_timeout"],
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/login", "infrastructure", "network_unreachable"],
    ["locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByText('Email is required')", "automation", "ui_step_failed"],
    ["something nobody has seen before", "unclassified", "unclassified_error"],
  ];
  for (const [message, failureClass, reasonCode] of table) {
    const c = classify({ error: new Error(message) });
    assert.deepEqual([c.failureClass, c.reasonCode], [failureClass, reasonCode], message.slice(0, 50));
  }
});

test("a plain Error with the same words as an assertion is NOT functional (only CheckAssertionError is)", () => {
  assert.equal(classifyThrown(new Error("The password is not masked.")).failureClass, "unclassified");
});

// ---------- finalizing from saved rows ----------

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-runlive-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({ db, audit, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function seedRun(db, scenarios = ["password_masked", "empty_fields", "valid_login"]) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ title: "Login essentials", scenarios }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "running", 0, new Date().toISOString());
  return runId;
}
const saveResult = (db, runId, status, failureClass = null, reasonCode = null) =>
  db.prepare("INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,failure_class,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), runId, `s-${randomUUID().slice(0, 4)}`, "t", status, "e", "a", 1, failureClass, reasonCode);
const runRow = (db, runId) => db.prepare("SELECT status,outcome,checks_planned,checks_executed,checks_passed,checks_failed,summary,finished_at FROM runs WHERE id=?").get(runId);

test("every planned check saved and passed -> the run passed, with the login suite's own note kept", () => {
  withDb(({ db }) => {
    const runId = seedRun(db);
    for (let i = 0; i < 3; i++) saveResult(db, runId, "passed");
    finalizeFromSavedResults(db, runId, { planned: 3, extraSummary: "First staging execution. Zero model calls." });
    const run = runRow(db, runId);
    assert.deepEqual([run.status, run.outcome, run.checks_planned, run.checks_executed, run.checks_passed, run.checks_failed], ["passed", "passed", 3, 3, 3, 0]);
    assert.match(run.summary, /^3 of 3 check\(s\) executed and passed\. First staging execution\. Zero model calls\.$/);
    assert.ok(run.finished_at);
  });
});

test("planned checks with no saved row are NOT run: the run is partial, never a pass", () => {
  withDb(({ db }) => {
    const runId = seedRun(db);
    saveResult(db, runId, "passed");
    saveResult(db, runId, "passed");
    finalizeFromSavedResults(db, runId, { planned: 4 });
    const run = runRow(db, runId);
    assert.deepEqual([run.status, run.outcome, run.checks_planned, run.checks_executed], ["interrupted", "partial", 4, 2]);
    assert.match(run.summary, /2 of 4 planned check\(s\) were not run/);
  });
});

test("the class of each failed row decides the verdict", () => {
  withDb(({ db }) => {
    const cases = [
      [["functional", "assertion_failed"], "failed", "failed"],
      [["infrastructure", "credentials_rejected"], "inconclusive", "interrupted"],
      [["integrity", "evidence_save_failed"], "inconclusive", "interrupted"],
      [["automation", "ui_step_failed"], "inconclusive", "interrupted"],
      [[null, null], "failed", "failed"], // no class = an older row, read as functional
    ];
    for (const [[failureClass, reasonCode], outcome, status] of cases) {
      const runId = seedRun(db);
      saveResult(db, runId, "passed");
      saveResult(db, runId, "failed", failureClass, reasonCode);
      finalizeFromSavedResults(db, runId, { planned: 2 });
      const run = runRow(db, runId);
      assert.deepEqual([run.outcome, run.status, run.checks_failed], [outcome, status, 1], String(failureClass));
    }
  });
});

test("no rows at all is inconclusive: nothing was verified", () => {
  withDb(({ db }) => {
    const runId = seedRun(db);
    finalizeFromSavedResults(db, runId, { planned: 3 });
    const run = runRow(db, runId);
    assert.deepEqual([run.outcome, run.status], ["inconclusive", "interrupted"]);
    assert.match(run.summary, /0 of 3 planned check\(s\) executed/);
  });
});

// ---------- the crash path of the real runLive ----------

test("runLive crashing before any check (here: live access forbidden) records a classified, counted, non-green run", async () => {
  await withDb(async ({ db, audit, dir }) => {
    const runId = seedRun(db, ["password_masked", "valid_login"]);
    await runLive({ db, audit, runId, artifactDirectory: join(dir, "artifacts"), apiContracts: null, networkObservations: null });
    const run = runRow(db, runId);
    assert.deepEqual([run.status, run.outcome, run.checks_planned, run.checks_executed], ["interrupted", "inconclusive", 2, 0]);
    assert.match(run.summary, /Classified as infrastructure \(live_access_forbidden\)/);
    assert.match(run.summary, /No pass is claimed\.$/);
    assert.ok(run.finished_at);
    const event = db.prepare("SELECT details FROM audit_events WHERE action='run.interrupted'").get();
    assert.equal(JSON.parse(event.details).reasonCode, "live_access_forbidden");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM scenario_results WHERE run_id=?").get(runId).n, 0);
  });
});

// ---------- wiring inside runLive that cannot run without a real browser ----------

test("runLive records class, code and evidence status per check, uses the shared finalizer, and only real assertions are functional", () => {
  const source = readFileSync(new URL("../core/live-runner.mjs", import.meta.url), "utf8");
  assert.match(source, /INSERT INTO scenario_results\(id,run_id,scenario,title,status,expected,actual,duration_ms,healed,failure_class,reason_code,evidence_status\)/);
  assert.match(source, /classification\?\.failureClass\?\?null,classification\?\.reasonCode\?\?null,evidenceProblem\?'save_failed':/);
  assert.match(source, /finalizeFromSavedResults\(db,runId,\{planned:plan\.scenarios\.length/);
  assert.match(source, /finalizeRun\(db,runId,\{planned:plan\.scenarios\.length,error\}\)/);
  assert.match(source, /Evidence for \$\{evidenceLost\} check\(s\) could not be saved\./, "the summary never claims encrypted evidence that was not saved");
  assert.doesNotMatch(source, /run\(failed\?'failed':'passed'/, "no direct status write for a finished run");
  assert.doesNotMatch(source, /UPDATE runs SET status='interrupted',finished_at=\?,summary=\?[^;]*The staging run could not start or complete/, "the generic crash summary is gone");
  for (const message of ["The password is not masked.", "Empty credentials were submitted or no validation was observed.", "The API did not explicitly reject the credentials.", "Protected content remained accessible.", "The test browser remained authenticated after logout."]) {
    assert.ok(source.includes(`throw new CheckAssertionError('${message}')`), message);
  }
  assert.match(source, /classification=EVIDENCE_SAVE_FAILED/);
  assert.match(source, /classification=classifyReportedFailure\(result\.mismatchReason\)/);
  assert.match(source, /\(loginStatus===401\|\|loginStatus===403\)&&scenario!=='invalid_password'/, "the expected 401 of the incorrect-password check is not a rejected account");
});
