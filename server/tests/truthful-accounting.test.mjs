import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openProposals } from "../core/proposals.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { summarizeCells, finalizeRun } from "../core/run-outcome.mjs";
import { attachEvidence, takeEvidence } from "../core/evidence.mjs";
import { checkStagingBudget } from "../core/run-admission.mjs";
import { currentCodeRevision } from "../core/code-revision.mjs";
import { planImpactedTest, executeImpactedTest } from "../core/impacted-testing.mjs";
import { seedLawcusNativeCases, NATIVE_QUARANTINE } from "../testbook/lawcus-native-cases.mjs";
import { runApprovedTest, runApprovedSuite, McpToolError, MCP_ERROR } from "../mcp/tools.mjs";

// Tripwire: nothing in this file may ever reach the real Keychain or launch a
// browser (see secrets.mjs / live-runner.mjs). If a safeguard under test is
// broken, the code under test throws here instead of touching live staging.
process.env.QA_FORBID_LIVE = "1";

// These are the harness's own negative controls: cases where a run must NOT
// be green (nothing executed, partial, crashed, quarantined, evidence lost).

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-truthful-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({
      dir,
      db,
      audit,
      knowledge: openKnowledge(db, audit),
      testbook: openTestBook(db, audit),
      proposals: openProposals(db, audit),
      apiContracts: openApiContracts(db, audit),
      mutationJournal: openMutationJournal(db, audit),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db, { status = "passed", startedAt = new Date().toISOString(), environmentId = "lawcus" } = {}) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, environmentId, "t", "intent", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, status, 0, startedAt);
  return runId;
}

const cell = (externalId, extra = {}) => ({ featureName: "Contacts", recordState: "n/a", externalId, covered: true, ...extra });

function registerCase(testbook, id, { status = "approved" } = {}) {
  testbook.syncCases({
    featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d",
    entries: { [id]: { source: `src-${id}`, definition: { id, name: id, layer: "both", risk: "normal", status } } },
  });
}

// ---------- summarizeCells ----------

test("summarizeCells: a run that executed nothing is never passed", () => {
  for (const results of [[], [{ executed: false }, { executed: false }]]) {
    const v = summarizeCells(results);
    assert.equal(v.outcome, "inconclusive");
    assert.equal(v.status, "interrupted");
    assert.notEqual(v.status, "passed");
    assert.match(v.summary, /no pass is claimed/i);
  }
});

test("summarizeCells: only a fully executed, fully passing run is passed", () => {
  const v = summarizeCells([{ executed: true, status: "passed" }, { executed: true, status: "passed" }]);
  assert.deepEqual([v.outcome, v.status, v.planned, v.executed, v.passed, v.failed, v.notRun], ["passed", "passed", 2, 2, 2, 0, 0]);
});

test("summarizeCells: any failure fails the run, even alongside passes and not-run cells", () => {
  const v = summarizeCells([{ executed: true, status: "passed" }, { executed: true, status: "failed" }, { executed: false }]);
  assert.equal(v.outcome, "failed");
  assert.equal(v.status, "failed");
  assert.equal(v.notRun, 1);
});

test("summarizeCells: passes plus not-run cells is partial, not green", () => {
  const v = summarizeCells([{ executed: true, status: "passed" }, { executed: false }]);
  assert.equal(v.outcome, "partial");
  assert.equal(v.status, "interrupted");
  assert.match(v.summary, /1 of 2 planned/);
});

test("summarizeCells: any executed status other than 'passed' counts as a failure", () => {
  const v = summarizeCells([{ executed: true, status: "inconclusive" }]);
  assert.equal(v.outcome, "failed");
});

// ---------- finalizeRun ----------

test("finalizeRun writes the real counts and never marks a crashed run passed", () => {
  withApp(({ db }) => {
    const runId = seedRun(db, { status: "running" });
    // Two checks were recorded before the crash.
    for (const [scenario, status] of [["a", "passed"], ["b", "failed"]]) {
      db.prepare("INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,healed) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), runId, scenario, scenario, status, "e", "a", 1, 0);
    }
    const v = finalizeRun(db, runId, { planned: 4, error: new Error("browser exploded") });
    assert.equal(v.status, "interrupted");
    const row = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
    assert.equal(row.status, "interrupted");
    assert.equal(row.outcome, "inconclusive");
    assert.deepEqual([row.checks_planned, row.checks_executed, row.checks_passed, row.checks_failed], [4, 2, 1, 1]);
    assert.match(row.summary, /browser exploded/);
    assert.match(row.summary, /no pass is claimed/i);
    assert.ok(row.finished_at);
  });
});

test("finalizeRun with a crash and zero recorded checks is still not green", () => {
  withApp(({ db }) => {
    const runId = seedRun(db);
    finalizeRun(db, runId, { planned: 3, error: new Error("setup failed") });
    const row = db.prepare("SELECT status, outcome, checks_executed FROM runs WHERE id=?").get(runId);
    assert.deepEqual([row.status, row.outcome, row.checks_executed], ["interrupted", "inconclusive", 0]);
  });
});

test("finalizeRun on normal results records the passed verdict and appends the extra summary", () => {
  withApp(({ db }) => {
    const runId = seedRun(db);
    finalizeRun(db, runId, { results: [{ executed: true, status: "passed" }], extraSummary: "1 gap(s) proposed for review." });
    const row = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
    assert.deepEqual([row.status, row.outcome, row.checks_planned, row.checks_executed], ["passed", "passed", 1, 1]);
    assert.match(row.summary, /1 gap\(s\) proposed/);
  });
});

// ---------- evidence channel ----------

test("evidence attached to an error is invisible to JSON, inspect and enumeration, and is taken exactly once", () => {
  const secretish = Buffer.from("PNG-BYTES-MARKER");
  const error = new Error("check failed");
  attachEvidence(error, { screenshot: secretish });
  assert.deepEqual(Object.keys(error), []);
  assert.equal(JSON.stringify(error), "{}");
  assert.ok(!inspect(error).includes("PNG-BYTES-MARKER"));
  assert.ok(!inspect(error).includes("screenshot"));
  assert.equal(takeEvidence(error).screenshot, secretish);
  assert.equal(takeEvidence(error), null, "second take must find nothing");
  assert.equal(takeEvidence(new Error("never had evidence")), null);
  assert.equal(takeEvidence(null), null);
});

// ---------- admission ----------

test("checkStagingBudget refuses at the limit, counts only the environment and only the window", () => {
  withApp(({ db }) => {
    const nowMs = Date.now();
    seedRun(db, { startedAt: new Date(nowMs - 60_000).toISOString() });
    seedRun(db, { startedAt: new Date(nowMs - 120_000).toISOString() });
    seedRun(db, { startedAt: new Date(nowMs - 3_600_000).toISOString() }); // outside window
    const otherEnv = db.prepare("SELECT id FROM environments WHERE id<>'lawcus' LIMIT 1").get().id;
    seedRun(db, { startedAt: new Date(nowMs - 30_000).toISOString(), environmentId: otherEnv });
    let b = checkStagingBudget(db, "lawcus", { nowMs });
    assert.deepEqual([b.ok, b.recent], [true, 2]);
    seedRun(db, { startedAt: new Date(nowMs - 10_000).toISOString() });
    b = checkStagingBudget(db, "lawcus", { nowMs });
    assert.deepEqual([b.ok, b.recent], [false, 3]);
  });
});

test("code revision is a non-empty string and never throws", () => {
  const rev = currentCodeRevision();
  assert.equal(typeof rev, "string");
  assert.ok(rev.length > 0);
});

// ---------- TestBook: status drift, quarantine ----------

test("a status change with an unchanged source hash still takes effect, without a new version", () => {
  withApp(({ testbook, db }) => {
    registerCase(testbook, "x.case", { status: "approved" });
    const before = db.prepare("SELECT current_version FROM test_cases WHERE external_id=?").get("x.case").current_version;
    testbook.syncCases({
      featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d",
      entries: { "x.case": { source: "src-x.case", definition: { id: "x.case", name: "x.case", layer: "both", risk: "normal", status: "pending_review" } } },
    });
    const row = db.prepare("SELECT status, current_version FROM test_cases WHERE external_id=?").get("x.case");
    assert.equal(row.status, "pending_review");
    assert.equal(row.current_version, before, "no new version for an unchanged source");
  });
});

test("quarantine is separate from approval, is idempotent, and needs a reason", () => {
  withApp(({ testbook }) => {
    registerCase(testbook, "q.case");
    assert.equal(testbook.findCase("q.case").runnable, true);
    assert.throws(() => testbook.setAutomationReadiness("q.case", "quarantined"), /requires a reason/);
    assert.throws(() => testbook.setAutomationReadiness("q.case", "bogus"), /Unknown automation readiness/);
    assert.equal(testbook.setAutomationReadiness("q.case", "quarantined", "known broken"), true);
    assert.equal(testbook.setAutomationReadiness("q.case", "quarantined", "known broken"), false, "unchanged value is a no-op");
    const c = testbook.findCase("q.case");
    assert.equal(c.status, "approved", "still approved as a definition");
    assert.equal(c.runnable, false);
    assert.equal(c.quarantineReason, "known broken");
    assert.equal(testbook.setAutomationReadiness("nope.nope", "ready"), false, "unknown case is a no-op");
    testbook.setAutomationReadiness("q.case", "ready");
    assert.equal(testbook.findCase("q.case").runnable, true);
  });
});

test("seedLawcusNativeCases quarantines exactly the declared cases, idempotently, and keeps them approved", () => {
  withApp(({ testbook }) => {
    seedLawcusNativeCases(testbook);
    seedLawcusNativeCases(testbook);
    for (const id of Object.keys(NATIVE_QUARANTINE)) {
      const c = testbook.findCase(id);
      assert.equal(c.status, "approved");
      assert.equal(c.automationReadiness, "quarantined");
      assert.equal(c.runnable, false);
      assert.ok(c.quarantineReason.length > 20);
    }
    assert.equal(testbook.findCase("contacts.custom_field_update_existing").runnable, true);
    assert.ok(Object.keys(NATIVE_QUARANTINE).includes("contacts.create_all_fields_verified_on_detail_page"));
  });
});

// ---------- planning: quarantined cells ----------

test("a quarantined case is not covered and not a gap to propose tests for", () => {
  withApp(({ knowledge, testbook }) => {
    knowledge.ensureFeature("Contact Custom Fields", "d");
    for (const id of ["contacts.custom_field_update_existing", "contacts.create_new_verifies_custom_fields", "leads.custom_field_update_existing", "leads.create_new_verifies_custom_fields"]) registerCase(testbook, id);
    testbook.setAutomationReadiness("contacts.custom_field_update_existing", "quarantined", "broken");
    const plan = planImpactedTest({ intent: "Update a contact custom field and check how it appears for existing/new Contact and Lead.", knowledge, testbook });
    const q = plan.cells.find((c) => c.externalId === "contacts.custom_field_update_existing");
    assert.equal(q.covered, false);
    assert.equal(q.blockedReason, "quarantined");
    assert.ok(!plan.gaps.some((g) => g.externalId === q.externalId), "must not be proposed as a missing-coverage gap");
    assert.equal(plan.quarantined.length, 1);
  });
});

// ---------- executeImpactedTest: evidence status ----------

function planWith(externalIds) {
  return { cells: externalIds.map((id) => cell(id)) };
}

test("evidence is saved and recorded as 'saved' when the sealer works", async () => {
  await withApp(async ({ db, testbook, dir }) => {
    registerCase(testbook, "e.case");
    const runId = seedRun(db);
    const artifactDirectory = join(dir, "artifacts");
    const results = await executeImpactedTest({
      plan: planWith(["e.case"]), db, runId, testbook, delayBetweenRunsMs: 0, artifactDirectory,
      sealer: async (b) => Buffer.concat([Buffer.from("SEALED:"), b]),
      runners: { "e.case": async () => ({ passed: false, actual: "x", reason: "field was wrong", screenshot: Buffer.from("png") }) },
    });
    assert.equal(results[0].evidenceStatus, "saved");
    assert.equal(db.prepare("SELECT evidence_status FROM scenario_results WHERE id=?").get(results[0].scenarioResultId).evidence_status, "saved");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM artifacts WHERE scenario_result_id=?").get(results[0].scenarioResultId).n, 1);
    assert.equal(readdirSync(artifactDirectory).length, 1);
    assert.equal(db.prepare("SELECT question FROM clarifications WHERE run_id=?").get(runId).question, "field was wrong");
  });
});

test("a failed evidence save is recorded explicitly, never changes pass/fail, and never leaks the error text", async () => {
  await withApp(async ({ db, testbook, dir, audit }) => {
    registerCase(testbook, "f.case");
    registerCase(testbook, "p.case");
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: planWith(["f.case", "p.case"]), db, runId, testbook, delayBetweenRunsMs: 0, artifactDirectory: join(dir, "artifacts"), audit,
      sealer: async () => { throw new Error("KEYCHAIN-SECRET-DETAIL"); },
      runners: {
        "f.case": async () => ({ passed: false, actual: "x", reason: "real product failure", screenshot: Buffer.from("png") }),
        "p.case": async () => ({ passed: true, actual: "ok", screenshot: Buffer.from("png") }),
      },
    });
    assert.deepEqual(results.map((r) => [r.status, r.evidenceStatus]), [["failed", "save_failed"], ["passed", "save_failed"]]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM artifacts").get().n, 0);
    const texts = db.prepare("SELECT question FROM clarifications WHERE run_id=?").all(runId).map((r) => r.question).join("\n");
    assert.match(texts, /real product failure/);
    assert.match(texts, /could not be saved/);
    assert.ok(!texts.includes("KEYCHAIN-SECRET-DETAIL"), "an internal error message must not reach the operator-facing text");
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='evidence.save_failed'").get(), "the integrity problem is audited");
  });
});

test("evidence carried on a thrown error via the private channel is saved; a bare throw records 'none_captured'", async () => {
  await withApp(async ({ db, testbook, dir }) => {
    registerCase(testbook, "t.case");
    registerCase(testbook, "b.case");
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: planWith(["t.case", "b.case"]), db, runId, testbook, delayBetweenRunsMs: 0, artifactDirectory: join(dir, "artifacts"),
      sealer: async (b) => b,
      runners: {
        "t.case": async () => { throw attachEvidence(new Error("no uuid in URL"), { screenshot: Buffer.from("png") }); },
        "b.case": async () => { throw new Error("plain failure"); },
      },
    });
    assert.deepEqual(results.map((r) => [r.status, r.evidenceStatus]), [["failed", "saved"], ["failed", "none_captured"]]);
    assert.match(results[0].actual, /no uuid in URL/);
  });
});

test("with no artifact directory configured, evidence is reported as not persisted rather than saved", async () => {
  await withApp(async ({ db, testbook }) => {
    registerCase(testbook, "n.case");
    const runId = seedRun(db);
    const results = await executeImpactedTest({
      plan: planWith(["n.case"]), db, runId, testbook, delayBetweenRunsMs: 0,
      runners: { "n.case": async () => ({ passed: true, actual: "ok", screenshot: Buffer.from("png") }) },
    });
    assert.equal(results[0].evidenceStatus, "not_persisted");
  });
});

// ---------- MCP entry points: no false green ----------

test("run_approved_suite with nothing eligible executes nothing and is NOT passed", async () => {
  await withApp(async ({ db, testbook, apiContracts, mutationJournal }) => {
    // The suite's cases were never synced into this TestBook, so none is runnable.
    const out = await runApprovedSuite({ db, testbook, apiContracts, mutationJournal }, { suiteName: "Create Contact - Person" });
    assert.equal(out.outcome, "inconclusive");
    assert.ok(out.results.length > 0 && out.results.every((r) => r.executed === false));
    const row = db.prepare("SELECT status, outcome, checks_executed, checks_planned, code_revision FROM runs WHERE id=?").get(out.runId);
    assert.equal(row.status, "interrupted");
    assert.notEqual(row.status, "passed");
    assert.equal(row.outcome, "inconclusive");
    assert.equal(row.checks_executed, 0);
    assert.equal(row.checks_planned, out.results.length);
    assert.ok(row.code_revision);
  });
});

test("run_approved_suite where every member is quarantined is not passed either", async () => {
  await withApp(async ({ db, testbook, apiContracts, mutationJournal }) => {
    seedLawcusNativeCases(testbook);
    for (const id of ["contacts.create_new_verifies_custom_fields", "contacts.create_mandatory_field_validation", "contacts.create_phone_number_validation", "contacts.create_billing_rate_required_validation", "contacts.create_all_fields_verified_on_detail_page"]) {
      testbook.setAutomationReadiness(id, "quarantined", "test quarantine");
    }
    const out = await runApprovedSuite({ db, testbook, apiContracts, mutationJournal }, { suiteName: "Create Contact - Person" });
    assert.equal(out.outcome, "inconclusive");
    assert.ok(out.results.every((r) => r.executed === false));
  });
});

test("run_approved_test refuses a quarantined case before any browser code runs", async () => {
  await withApp(async ({ db, testbook, apiContracts, mutationJournal }) => {
    seedLawcusNativeCases(testbook);
    await assert.rejects(
      runApprovedTest({ db, testbook, apiContracts, mutationJournal }, { externalId: "contacts.create_all_fields_verified_on_detail_page" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_RUNNABLE && /quarantined/.test(e.message),
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM runs").get().n, 0, "a refused request must not create a run");
  });
});

test("MCP run tools obey the same staging run budget as the app", async () => {
  await withApp(async ({ db, testbook, apiContracts, mutationJournal }) => {
    // No cases are seeded on purpose: if the guard were broken the suite
    // would run zero checks (and this assertion would fail) rather than run
    // anything real. runApprovedTest calls the very same ensureWithinRunBudget.
    for (let i = 0; i < 3; i++) seedRun(db, { status: "passed" });
    await assert.rejects(
      runApprovedSuite({ db, testbook, apiContracts, mutationJournal }, { suiteName: "Create Contact - Person" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.RATE_LIMITED,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running'").get().n, 0, "a refused request must not create a run");
  });
});

test("an exception inside execution finalizes the MCP run as interrupted — never green, never left 'running'", async () => {
  await withApp(async ({ db, testbook, apiContracts, mutationJournal }) => {
    seedLawcusNativeCases(testbook);
    // The real runner fails fast on the QA_FORBID_LIVE tripwire (recorded as
    // a failed check); then persisting that result blows up — an exception
    // that escapes executeImpactedTest itself.
    const brokenTestbook = new Proxy(testbook, {
      get(target, key) {
        if (key === "resolveCurrentDefinition") return () => { throw new Error("database exploded"); };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      runApprovedTest({ db, testbook: brokenTestbook, apiContracts, mutationJournal }, { externalId: "contacts.custom_field_update_existing" }),
      /database exploded/,
    );
    const row = db.prepare("SELECT status, outcome, finished_at, summary FROM runs").get();
    assert.equal(row.status, "interrupted");
    assert.equal(row.outcome, "inconclusive");
    assert.ok(row.finished_at, "a crashed run must not be left in 'running'");
    assert.match(row.summary, /database exploded/);
    assert.match(row.summary, /no pass is claimed/i);
  });
});
