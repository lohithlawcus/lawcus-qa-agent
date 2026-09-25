import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { parseTestCase, runTestCase, takeFailedStep } from "../core/dsl.mjs";
import { PrimitiveError } from "../core/primitives.mjs";
import { classifyStepFailure } from "../core/failure-class.mjs";
import { finalizeCancelledRun } from "../core/run-outcome.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

const header = (id) => `version: 1\nid: ${id}\nfeature: authentication\nsuite: login-essentials\nname: ${id}\nlayer: ui\nrisk: low\nstatus: approved\n`;
const maskedAssertion = parseTestCase(`${header("sample.masked")}steps:\n  - primitive: auth.open_login_page\n    input:\n      page: "\${ctx.page}"\n      origin: "\${ctx.origin}"\nassertions:\n  - primitive: auth.assert_password_masked\n    input:\n      password: "\${ctx.password}"\n`);
const openStep = parseTestCase(`${header("sample.open")}steps:\n  - primitive: auth.open_login_page\n    input:\n      page: "\${ctx.page}"\n      origin: "\${ctx.origin}"\n`);
const unknownInAssertions = parseTestCase(`${header("sample.unknown")}steps:\n  - primitive: auth.open_login_page\n    input:\n      page: "\${ctx.page}"\n      origin: "\${ctx.origin}"\nassertions:\n  - primitive: auth.does_not_exist\n    input:\n      page: "\${ctx.page}"\n`);

const okPage = { goto: async () => {} };
const catchError = async (definition, ctx) => {
  try {
    await runTestCase(definition, { ctx });
  } catch (error) {
    return error;
  }
  throw new Error("expected the case to throw");
};

// ---------- the failing step is remembered, without touching the (hash-pinned) primitives ----------

test("an assertion step that fails is remembered as an assertion step, on the real primitive", async () => {
  const error = await catchError(maskedAssertion, { page: okPage, origin: "http://x", password: { getAttribute: async () => "text" } });
  assert.match(error.message, /The password field is no longer concealed/);
  assert.deepEqual(takeFailedStep(error), { phase: "assertions", primitive: "auth.assert_password_masked" });
  assert.deepEqual(Object.keys(error), [], "kept off the error's own properties, so a logger cannot serialize it");
  assert.ok(!JSON.stringify(error).includes("assertions"));
});

test("a step that cannot drive the page is remembered as a steps failure; an unknown primitive keeps its PrimitiveError", async () => {
  const drive = await catchError(openStep, { page: { goto: async () => { throw new Error("page.goto: Timeout 7000ms exceeded."); } }, origin: "http://127.0.0.1:9" });
  assert.deepEqual(takeFailedStep(drive), { phase: "steps", primitive: "auth.open_login_page" });
  const gate = await catchError(unknownInAssertions, { page: okPage, origin: "http://x" });
  assert.ok(gate instanceof PrimitiveError && gate.code === "unknown_primitive");
  assert.deepEqual(takeFailedStep(gate), { phase: "assertions", primitive: "auth.does_not_exist" });
});

test("takeFailedStep is null for anything runTestCase did not throw, and never throws itself", () => {
  for (const value of [new Error("x"), null, undefined, "a string", 5, {}]) assert.equal(takeFailedStep(value), null);
});

test("a case that passes throws nothing and leaves nothing behind", async () => {
  const scope = await runTestCase(maskedAssertion, { ctx: { page: okPage, origin: "http://x", password: { getAttribute: async () => "password" } } });
  assert.ok(scope.ctx);
});

// ---------- classification by step ----------

const err = (message) => new Error(message);
const gateErr = (code, message) => new PrimitiveError(code, message);
const step = (phase) => ({ phase, primitive: "auth.x" });

test("a failed ASSERTION is functional even when it is a timeout (the app did not show what it should); a failed step is not", () => {
  const timeout = err("locator.waitFor: Timeout 3500ms exceeded.\nCall log:\n  - waiting for getByRole('alert').filter({ hasText: 'Invalid email or password' })");
  const inAssertion = classifyStepFailure(timeout, step("assertions"));
  assert.deepEqual([inAssertion.failureClass, inAssertion.reasonCode], ["functional", "assertion_failed"]);
  const inSteps = classifyStepFailure(timeout, step("steps"));
  assert.deepEqual([inSteps.failureClass, inSteps.reasonCode], ["automation", "ui_step_failed"]);
  assert.equal(classifyStepFailure(timeout, step("setup")).failureClass, "automation");
  assert.equal(classifyStepFailure(timeout, null).failureClass, "automation", "no step information: never assumed functional");
  assert.equal(classifyStepFailure(err("The password field is no longer concealed."), step("assertions")).failureClass, "functional");
  assert.equal(classifyStepFailure(err("something entirely new"), step("steps")).failureClass, "unclassified");
  assert.equal(classifyStepFailure(err("something entirely new"), null).failureClass, "unclassified");
});

test("environment and record problems win over the step: they are never functional, even inside an assertion", () => {
  const table = [
    [err("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4320/"), "infrastructure", "network_unreachable"],
    [err("locator.waitFor: Target page, context or browser has been closed"), "infrastructure", "browser_unavailable"],
    [gateErr("unknown_primitive", "No such approved primitive: auth.x"), "integrity", "primitive_not_trusted"],
    [gateErr("not_approved", "Primitive auth.x is not approved for execution."), "integrity", "primitive_not_trusted"],
    [gateErr("deprecated_primitive", "Primitive auth.x is deprecated and cannot execute."), "integrity", "primitive_not_trusted"],
    [gateErr("hash_mismatch", "Primitive auth.x's implementation changed since approval and is not trusted to execute. Re-review and update its approved hash."), "integrity", "primitive_not_trusted"],
    [gateErr("unknown_primitive", "No such primitive: auth.x"), "integrity", "primitive_not_trusted"],
  ];
  for (const [error, failureClass, reasonCode] of table) {
    for (const phase of ["setup", "steps", "assertions", "cleanup"]) {
      const c = classifyStepFailure(error, step(phase));
      assert.deepEqual([c.failureClass, c.reasonCode], [failureClass, reasonCode], `${phase}: ${error.message.slice(0, 50)}`);
    }
  }
});

test("a control that cannot be singled out on the page is an automation problem with its own code", () => {
  for (const message of ["The login fields could not be identified uniquely.", "The sign-in action is ambiguous.", "The sign-in action could not be identified uniquely."]) {
    const c = classifyStepFailure(err(message), step("steps"));
    assert.deepEqual([c.failureClass, c.reasonCode], ["automation", "locator_unresolved"], message);
    assert.match(c.explanation, /does not show the application is wrong/);
  }
});

// ---------- cancelled runs ----------

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-fixture-acc-"));
  try {
    const { db } = openStore(dir);
    return fn(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "fixture", "t", "i", "built-in", JSON.stringify({ title: "Login essentials", scenarios: ["valid_login"] }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "running", 0, new Date().toISOString());
  return runId;
}
const saved = (db, runId, status) =>
  db.prepare("INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), runId, `s-${randomUUID().slice(0, 4)}`, "t", status, "e", "a", 1);

test("a cancelled run records real counts, says nothing was claimed for unstarted checks, and is neither a pass nor a failure", () => {
  withDb((db) => {
    const none = seedRun(db);
    finalizeCancelledRun(db, none, { planned: 5 });
    const a = db.prepare("SELECT status,outcome,checks_planned,checks_executed,checks_passed,checks_failed,summary,finished_at FROM runs WHERE id=?").get(none);
    assert.deepEqual([a.status, a.outcome, a.checks_planned, a.checks_executed, a.checks_passed, a.checks_failed], ["cancelled", "cancelled", 5, 0, 0, 0]);
    assert.match(a.summary, /^Run cancelled by the operator after 0 of 5 checks\. No result is claimed for the checks that had not started\.$/);
    assert.ok(a.finished_at);
    const some = seedRun(db);
    saved(db, some, "passed");
    saved(db, some, "passed");
    saved(db, some, "failed");
    const verdict = finalizeCancelledRun(db, some, { planned: 5 });
    assert.deepEqual([verdict.executed, verdict.passed, verdict.failed, verdict.outcome], [3, 2, 1, "cancelled"]);
    const b = db.prepare("SELECT status,outcome,checks_executed,checks_passed,checks_failed FROM runs WHERE id=?").get(some);
    assert.deepEqual([b.status, b.outcome, b.checks_executed, b.checks_passed, b.checks_failed], ["cancelled", "cancelled", 3, 2, 1]);
  });
});

// ---------- wiring ----------

test("the runner has no accounting of its own left: shared finalizers, classified failures, evidence status, and the primitives are untouched", () => {
  const runner = readFileSync(new URL("../core/runner.mjs", import.meta.url), "utf8");
  for (const wired of ["classifyStepFailure(error, takeFailedStep(error))", "finalizeFromSavedResults(db, runId", "finalizeCancelledRun(db, runId", "finalizeRun(db, runId, { planned: plan.scenarios.length, error })", "classification = EVIDENCE_SAVE_FAILED", "failure_class,reason_code,evidence_status"]) {
    assert.ok(runner.includes(wired), wired);
  }
  assert.doesNotMatch(runner, /blockedCount|reviewCount|overallStatus/, "no private status arithmetic");
  assert.doesNotMatch(runner, /UPDATE runs SET status/, "no direct write of a run's status");
  assert.doesNotMatch(runner, /status = "blocked"|"needs_review"/);
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(index, /Execution stopped unexpectedly/);
  assert.match(index, /finalizeRun\(db, id, \{ planned: null, error \}\)/);
  const primitives = readFileSync(new URL("../core/primitives.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(primitives, /CheckAssertionError|takeFailedStep/, "the hash-pinned primitives were not changed to carry classification");
});
