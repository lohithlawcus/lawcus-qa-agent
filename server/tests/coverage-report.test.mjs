import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { buildCoverageReport, COVERAGE_STATES } from "../core/coverage-report.mjs";
import { getCoverageReport, McpToolError } from "../mcp/tools.mjs";

process.env.QA_FORBID_LIVE = "1";
const NOW = Date.parse("2026-09-26T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-coverage-"));
  try {
    const { db, audit } = openStore(dir);
    const testbook = openTestBook(db, audit);
    const entry = (id, status = "approved") => ({ source: JSON.stringify({ kind: "native", module: "m", function: "f" }), definition: { id, name: id, layer: "both", risk: "normal", status } });
    const addCases = (ids, statuses = {}) =>
      testbook.syncCases({ featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d", entries: Object.fromEntries(ids.map((id) => [id, entry(id, statuses[id])])) });
    const caseId = (external) => db.prepare("SELECT id FROM test_cases WHERE external_id=?").get(external).id;
    const runbooks = {};
    const record = (external, { env = "lawcus", status = "passed", failureClass = null, reason = null, at, revision = null, outcome = null }) => {
      runbooks[env] ??= (() => { const id = randomUUID(); db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(id, 1, env, "t", "i", "built-in", "{}", at); return id; })();
      const runId = randomUUID();
      db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at,code_revision,outcome) VALUES(?,?,?,?,?,?,?)").run(runId, runbooks[env], status === "passed" ? "passed" : "failed", 0, at, revision, outcome);
      db.prepare("INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,test_case_id,failure_class,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), runId, external, external, status, "e", "a", 1, caseId(external), failureClass, reason);
    };
    return fn({ db, testbook, addCases, record });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stateOf = (report, id) => report.cases.find((c) => c.externalId === id).state;

test("a recent pass on staging counts; an old pass is stale; a functional failure is failing", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["a.recent", "a.old", "a.broken"]);
    record("a.recent", { at: daysAgo(2) });
    record("a.old", { at: daysAgo(30) });
    record("a.broken", { at: daysAgo(3), status: "failed", failureClass: "functional" });
    const r = buildCoverageReport(db, { nowMs: NOW });
    assert.equal(stateOf(r, "a.recent"), "covered");
    assert.equal(stateOf(r, "a.old"), "stale");
    assert.equal(stateOf(r, "a.broken"), "failing");
    assert.equal(r.summary.coveredCases, 1);
    assert.equal(r.cases.find((c) => c.externalId === "a.recent").countsAsCoverage, true);
    assert.equal(r.cases.find((c) => c.externalId === "a.old").countsAsCoverage, false);
  }));

test("a case that never ran on staging, or ran only on the fixture, is never_run_on_staging", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["b.never", "b.fixture"]);
    record("b.fixture", { env: "fixture", at: daysAgo(1) });
    const r = buildCoverageReport(db, { nowMs: NOW });
    assert.equal(stateOf(r, "b.never"), "never_run_on_staging");
    assert.equal(stateOf(r, "b.fixture"), "never_run_on_staging");
    assert.equal(r.cases.find((c) => c.externalId === "b.fixture").otherEnvironments.fixture.status, "passed");
  }));

test("failures caused by the environment or the tool do not count for or against a check", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["c.pass_then_infra", "c.only_infra"]);
    record("c.pass_then_infra", { at: daysAgo(5) });
    record("c.pass_then_infra", { at: daysAgo(1), status: "failed", failureClass: "infrastructure", reason: "login_timeout" });
    record("c.only_infra", { at: daysAgo(1), status: "failed", failureClass: "automation", reason: "locator_unresolved" });
    const r = buildCoverageReport(db, { nowMs: NOW });
    const a = r.cases.find((c) => c.externalId === "c.pass_then_infra");
    assert.equal(a.state, "covered");
    assert.equal(a.newerInconclusiveAttempt, true); // the pass stands but is not the latest word
    assert.equal(a.lastAttempt.reasonCode, "login_timeout");
    assert.equal(stateOf(r, "c.only_infra"), "inconclusive");
    assert.equal(r.cases.find((c) => c.externalId === "c.only_infra").countsAsCoverage, false);
  }));

test("a failure recorded before classification existed counts against the check", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["d.legacy"]);
    record("d.legacy", { at: daysAgo(4), status: "failed", failureClass: null });
    assert.equal(stateOf(buildCoverageReport(db, { nowMs: NOW }), "d.legacy"), "failing");
  }));

test("a later pass after a failure counts again", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["e.recovered"]);
    record("e.recovered", { at: daysAgo(6), status: "failed", failureClass: "functional" });
    record("e.recovered", { at: daysAgo(1) });
    assert.equal(stateOf(buildCoverageReport(db, { nowMs: NOW }), "e.recovered"), "covered");
  }));

test("quarantined and not-approved checks never count, even with a recent pass", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["f.quarantined", "f.pending"], { "f.pending": "pending_review" });
    db.prepare("UPDATE test_cases SET automation_readiness='quarantined', quarantine_reason='Tag picker broken' WHERE external_id='f.quarantined'").run();
    record("f.quarantined", { at: daysAgo(1) });
    record("f.pending", { at: daysAgo(1) });
    const r = buildCoverageReport(db, { nowMs: NOW });
    assert.equal(stateOf(r, "f.quarantined"), "quarantined");
    assert.equal(r.cases.find((c) => c.externalId === "f.quarantined").quarantineReason, "Tag picker broken");
    assert.equal(stateOf(r, "f.pending"), "not_approved");
    assert.equal(r.summary.coveredCases, 0);
  }));

test("the summary counts every state and every state has an explanation", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["g.one", "g.two"]);
    record("g.one", { at: daysAgo(1) });
    const r = buildCoverageReport(db, { nowMs: NOW });
    assert.equal(r.summary.cases, 2);
    assert.equal(Object.values(r.summary.byState).reduce((a, b) => a + b, 0), 2);
    assert.deepEqual(Object.keys(r.summary.byState).sort(), Object.keys(COVERAGE_STATES).sort());
  }));

test("quality: counts failures by class with denominators, excludes the fixture and old runs, and says when nothing is classified", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["h.one"]);
    record("h.one", { at: daysAgo(1) });
    record("h.one", { at: daysAgo(2), status: "failed", failureClass: "functional" });
    record("h.one", { at: daysAgo(3), status: "failed", failureClass: "infrastructure" });
    record("h.one", { at: daysAgo(4), status: "failed", failureClass: null });
    record("h.one", { env: "fixture", at: daysAgo(1), status: "failed", failureClass: "functional" });
    record("h.one", { at: daysAgo(200), status: "failed", failureClass: "functional" });
    const q = buildCoverageReport(db, { nowMs: NOW }).quality;
    assert.deepEqual(q.checks, { executed: 4, passed: 1, failed: 3, neitherPassedNorFailed: 0 });
    assert.equal(q.failuresByClass.functional, 1);
    assert.equal(q.failuresByClass.infrastructure, 1);
    assert.equal(q.failuresByClass.unlabelled, 1);
    assert.equal(q.functionalShareOfFailures, 50); // 1 of the 2 classified failures
    assert.equal(q.functionalShareBasis, 2);
  }));

test("quality: with only unclassified history the functional share is null, not zero", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["i.one"]);
    record("i.one", { at: daysAgo(1), status: "failed", failureClass: null });
    const q = buildCoverageReport(db, { nowMs: NOW }).quality;
    assert.equal(q.functionalShareOfFailures, null);
    assert.equal(q.functionalShareBasis, 0);
  }));

test("quality: flaky means the same check, tenant and code revision both passed and failed conclusively", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["j.flaky", "j.steady", "j.changed_code", "j.no_revision"]);
    record("j.flaky", { at: daysAgo(2), revision: "abc" });
    record("j.flaky", { at: daysAgo(1), revision: "abc", status: "failed", failureClass: "functional" });
    record("j.steady", { at: daysAgo(2), revision: "abc" });
    record("j.steady", { at: daysAgo(1), revision: "abc" });
    record("j.changed_code", { at: daysAgo(2), revision: "abc" });
    record("j.changed_code", { at: daysAgo(1), revision: "def", status: "failed", failureClass: "functional" });
    record("j.no_revision", { at: daysAgo(2) });
    record("j.no_revision", { at: daysAgo(1), status: "failed", failureClass: "functional" });
    assert.deepEqual(buildCoverageReport(db, { nowMs: NOW }).quality.flakyCases, ["j.flaky"]);
  }));

test("the report only reads: nothing in the database changes", () =>
  withDb(({ db, addCases, record }) => {
    addCases(["k.one"]);
    record("k.one", { at: daysAgo(1) });
    const count = () => ["runs", "scenario_results", "test_cases", "audit_events"].map((t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return -1; } });
    const before = count();
    buildCoverageReport(db, { nowMs: NOW });
    assert.deepEqual(count(), before);
  }));

test("the MCP tool limits the report to one feature, case-insensitively, and recomputes the summary", () =>
  withDb(({ db, addCases, record, testbook }) => {
    addCases(["m.contact"]);
    testbook.syncCases({ featureName: "Leads", featureDescription: "d", suiteName: "ls", suiteDescription: "d", entries: { "m.lead": { source: JSON.stringify({ kind: "native", module: "m", function: "f" }), definition: { id: "m.lead", name: "m.lead", layer: "both", risk: "normal", status: "approved" } } } });
    record("m.contact", { at: daysAgo(1) });
    const whole = getCoverageReport({ db });
    assert.equal(whole.summary.cases, 2);
    const contacts = getCoverageReport({ db }, { feature: "contacts" });
    assert.deepEqual(contacts.cases.map((c) => c.externalId), ["m.contact"]);
    assert.equal(contacts.summary.cases, 1);
    assert.equal(contacts.summary.coveredCases, 1);
    const leads = getCoverageReport({ db }, { feature: "LEADS" });
    assert.equal(leads.summary.coveredCases, 0);
    assert.equal(leads.summary.byState.never_run_on_staging, 1);
    assert.throws(() => getCoverageReport({ db }, { feature: "Nope" }), (e) => e instanceof McpToolError && e.code === "not_found");
  }));
