import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, now } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";

const CASE_A_V1 = `
version: 1
id: sample.case-a
feature: authentication
suite: login-essentials
name: Case A
layer: ui
risk: low
status: approved
steps:
  - primitive: auth.open_login_page
    input: { page: "\${ctx.page}", origin: "\${ctx.origin}" }
`;

const CASE_A_V2 = CASE_A_V1.replace("name: Case A", "name: Case A (renamed)");

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-testbook-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(db, audit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function entriesFor(source) {
  return {
    case_a: {
      source,
      definition: {
        id: "sample.case-a",
        name: source.includes("renamed") ? "Case A (renamed)" : "Case A",
        layer: "ui",
        risk: "low",
        status: "approved",
      },
    },
  };
}

const SYNC_ARGS = {
  featureName: "Authentication",
  featureDescription: "Sign in and session behavior.",
  suiteName: "login-essentials",
  suiteDescription: "Bounded login checks.",
};

test("syncCases creates the feature, suite and case on first sync", () => {
  withStore((db, audit) => {
    const testbook = openTestBook(db, audit);
    const synced = testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    assert.equal(synced.length, 1);
    const tree = testbook.tree();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, "Authentication");
    assert.equal(tree[0].suites.length, 1);
    assert.equal(tree[0].suites[0].name, "login-essentials");
    assert.equal(tree[0].suites[0].cases.length, 1);
    const testCase = tree[0].suites[0].cases[0];
    assert.equal(testCase.externalId, "sample.case-a");
    assert.equal(testCase.title, "Case A");
    assert.equal(testCase.currentVersion, 1);
  });
});

test("syncing unchanged DSL source again does not create a new version (never rewrite history)", () => {
  withStore((db, audit) => {
    const testbook = openTestBook(db, audit);
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    const testCase = testbook.tree()[0].suites[0].cases[0];
    assert.equal(testCase.currentVersion, 1);
  });
});

test("syncing changed DSL source appends a new version instead of overwriting", () => {
  withStore((db, audit) => {
    const testbook = openTestBook(db, audit);
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V2) });
    const testCase = testbook.tree()[0].suites[0].cases[0];
    assert.equal(testCase.currentVersion, 2);
    assert.equal(testCase.title, "Case A (renamed)");
    const versions = db
      .prepare("SELECT version, dsl_source FROM test_definition_versions WHERE test_case_id=? ORDER BY version")
      .all(testCase.id);
    assert.equal(versions.length, 2);
    assert.match(versions[0].dsl_source, /name: Case A\n/);
    assert.match(versions[1].dsl_source, /name: Case A \(renamed\)/);
  });
});

test("resolveCurrentDefinition returns null for a case never synced, and the current version afterward", () => {
  withStore((db, audit) => {
    const testbook = openTestBook(db, audit);
    assert.equal(testbook.resolveCurrentDefinition("sample.case-a"), null);
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    const resolved = testbook.resolveCurrentDefinition("sample.case-a");
    assert.ok(resolved.testCaseId);
    assert.ok(resolved.versionId);
  });
});

test("case execution stats reflect linked scenario_results (executions/passed/failed/last-pass/last-failure)", () => {
  withStore((db, audit) => {
    const testbook = openTestBook(db, audit);
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    const { testCaseId } = testbook.resolveCurrentDefinition("sample.case-a");

    const book = randomUUID();
    db.prepare(
      "INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)",
    ).run(book, 1, "fixture", "t", "t", "built-in", '{"title":"t","scenarios":["valid_login"]}', now());

    function insertRun(status, startedAt) {
      const runId = randomUUID();
      db.prepare(
        "INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)",
      ).run(runId, book, "passed", 0, startedAt);
      db.prepare(
        `INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,healed,test_case_id)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(randomUUID(), runId, "valid_login", "t", status, "e", "a", 10, 0, testCaseId);
      return startedAt;
    }
    insertRun("passed", "2026-01-01T00:00:00.000Z");
    insertRun("failed", "2026-01-02T00:00:00.000Z");
    insertRun("passed", "2026-01-03T00:00:00.000Z");

    const stats = testbook.tree()[0].suites[0].cases[0].stats;
    assert.equal(stats.executions, 3);
    assert.equal(stats.passed, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.lastStatus, "passed");
    assert.equal(stats.lastExecutionAt, "2026-01-03T00:00:00.000Z");
    assert.equal(stats.lastPassAt, "2026-01-03T00:00:00.000Z");
    assert.equal(stats.lastFailureAt, "2026-01-02T00:00:00.000Z");
  });
});

test("backfillHistory links only unlinked rows matching by scenario name, and never invents a version", () => {
  withStore((db, audit) => {
    const testbook = openTestBook(db, audit);
    testbook.syncCases({ ...SYNC_ARGS, entries: entriesFor(CASE_A_V1) });
    const { testCaseId } = testbook.resolveCurrentDefinition("sample.case-a");

    const book = randomUUID();
    db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
      book, 1, "fixture", "t", "t", "built-in", '{"title":"t","scenarios":["valid_login"]}', now(),
    );
    const runId = randomUUID();
    db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(
      runId, book, "passed", 0, now(),
    );
    const resultId = randomUUID();
    // A pre-TestBook row: no test_case_id yet, matching a legacy scenario name.
    db.prepare(
      `INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,healed)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(resultId, runId, "valid_login", "t", "passed", "e", "a", 10, 0);

    const updated = testbook.backfillHistory({ valid_login: "sample.case-a" });
    assert.equal(updated, 1);
    const row = db.prepare("SELECT test_case_id, test_definition_version_id FROM scenario_results WHERE id=?").get(resultId);
    assert.equal(row.test_case_id, testCaseId);
    assert.equal(row.test_definition_version_id, null);

    // Running it again must not double-count or re-touch already-linked rows.
    const again = testbook.backfillHistory({ valid_login: "sample.case-a" });
    assert.equal(again, 0);
  });
});
