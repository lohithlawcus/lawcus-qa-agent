import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { openStore, now } from "../core/store.mjs";
import { builtInPlan } from "../core/contracts.mjs";
import { executeRun } from "../core/runner.mjs";
import { startFixture } from "../fixture.mjs";
test(
  "Real Chromium: first run, deterministic replay, safe repair, business defect and evidence",
  { timeout: 120000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-runner-"));
    const { db, audit } = openStore(dir);
    const fixture = await startFixture(0);
    const book = randomUUID();
    db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
      book,
      1,
      "fixture",
      "Login essentials",
      "Test login",
      "built-in",
      JSON.stringify(builtInPlan("Test login")),
      now(),
    );
    async function run() {
      const id = randomUUID();
      const path = db
        .prepare(
          "SELECT * FROM execution_paths WHERE runbook_id=? ORDER BY version DESC LIMIT 1",
        )
        .get(book);
      db.prepare(
        "INSERT INTO runs(id,runbook_id,status,replay,path_id,started_at) VALUES(?,?,?,?,?,?)",
      ).run(id, book, "running", path ? 1 : 0, path?.id || null, now());
      await executeRun({
        db,
        audit,
        runId: id,
        origin: fixture.origin,
        artifactDirectory: join(dir, "artifacts"),
      });
      return db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    }
    try {
      const first = await run();
      assert.equal(first.status, "passed", first.summary);
      assert.equal(first.replay, 0);
      // Shared accounting: the outcome and the counts are recorded, evidence is accounted for.
      assert.deepEqual([first.outcome, first.checks_planned, first.checks_executed, first.checks_passed, first.checks_failed], ["passed", 5, 5, 5, 0]);
      assert.match(first.summary, /^5 of 5 check\(s\) executed and passed\. First execution\. No model calls during execution\. Local test application only\.$/);
      const evidence = db.prepare("SELECT evidence_status, failure_class FROM scenario_results WHERE run_id=?").all(first.id);
      assert.ok(evidence.every((r) => r.evidence_status === "saved" && r.failure_class === null));
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM scenario_results WHERE run_id=?")
          .get(first.id).n,
        5,
      );
      const artifacts = db
        .prepare("SELECT * FROM artifacts WHERE run_id=?")
        .all(first.id);
      assert.equal(artifacts.length, 10);
      for (const a of artifacts)
        assert.ok(statSync(join(dir, "artifacts", a.filename)).size > 100);
      const second = await run();
      assert.equal(second.status, "passed");
      assert.equal(second.replay, 1);
      assert.equal(second.model_calls, 0);
      assert.equal(
        db.prepare("SELECT count(*) n FROM execution_paths").get().n,
        1,
      );
      fixture.state.label = "Log in";
      const repaired = await run();
      assert.equal(repaired.status, "passed");
      // V5 Step 1: a candidate locator no longer rewrites the trusted path —
      // it raises a LOCATOR_REPAIR proposal and the trusted path is untouched.
      assert.equal(
        db.prepare("SELECT count(*) n FROM execution_paths").get().n,
        1,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM scenario_results WHERE run_id=? AND healed=1")
          .get(repaired.id).n,
        0,
      );
      assert.ok(
        db
          .prepare(
            "SELECT count(*) n FROM proposals WHERE run_id=? AND type='LOCATOR_REPAIR' AND status='pending_review'",
          )
          .get(repaired.id).n > 0,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM trusted_versions").get().n,
        0,
      );
      fixture.state.acceptInvalid = true;
      const defect = await run();
      // A real defect (the app accepts bad credentials) FAILS the run: the assertion
      // step did not see the expected state, so it is a functional failure. (Earlier
      // this was stored as needs_review; new runs use the shared vocabulary.)
      assert.equal(defect.status, "failed");
      assert.equal(defect.outcome, "failed");
      assert.equal(defect.checks_failed, 1);
      const defectRow = db.prepare("SELECT scenario, failure_class, reason_code FROM scenario_results WHERE run_id=? AND status='failed'").get(defect.id);
      assert.deepEqual([defectRow.scenario, defectRow.failure_class, defectRow.reason_code], ["invalid_password", "functional", "assertion_failed"]);
      assert.match(db.prepare("SELECT question FROM clarifications WHERE run_id=?").get(defect.id).question, /defect/);
      assert.equal(
        db.prepare("SELECT count(*) n FROM execution_paths").get().n,
        1,
      );
      assert.ok(
        db
          .prepare("SELECT count(*) n FROM clarifications WHERE run_id=?")
          .get(defect.id).n > 0,
      );
      assert.deepEqual(
        JSON.parse(
          db.prepare("SELECT definition FROM runbooks WHERE id=?").get(book)
            .definition,
        ),
        builtInPlan("Test login"),
      );
    } finally {
      await new Promise((r) => fixture.server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "Real Chromium: an already-cancelled signal stops the run before any scenario executes",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-runner-cancel-"));
    const { db, audit } = openStore(dir);
    const fixture = await startFixture(0);
    const book = randomUUID();
    db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
      book,
      1,
      "fixture",
      "Login essentials",
      "Test login",
      "built-in",
      JSON.stringify(builtInPlan("Test login")),
      now(),
    );
    const runId = randomUUID();
    db.prepare(
      "INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)",
    ).run(runId, book, "running", 0, now());
    try {
      const controller = new AbortController();
      controller.abort();
      await executeRun({
        db,
        audit,
        runId,
        origin: fixture.origin,
        artifactDirectory: join(dir, "artifacts"),
        signal: controller.signal,
      });
      const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
      assert.equal(run.status, "cancelled");
      assert.deepEqual([run.outcome, run.checks_planned, run.checks_executed, run.checks_passed, run.checks_failed], ["cancelled", 5, 0, 0, 0]);
      assert.match(run.summary, /^Run cancelled by the operator after 0 of 5 checks\. No result is claimed/);
      assert.equal(
        db.prepare("SELECT count(*) n FROM scenario_results WHERE run_id=?").get(runId).n,
        0,
      );
      const auditEvent = db
        .prepare("SELECT * FROM audit_events WHERE action='run.cancelled' AND entity_id=?")
        .get(runId);
      assert.ok(auditEvent);
    } finally {
      await new Promise((r) => fixture.server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------- negative controls: each way a run can go wrong is accounted for as what it is ----------

async function withFixtureRun(fn, { setup } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qa-runner-neg-"));
  const { db, audit } = openStore(dir);
  const fixture = await startFixture(0);
  const book = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(book, 1, "fixture", "Login essentials", "Test login", "built-in", JSON.stringify(builtInPlan("Test login")), now());
  const artifactDirectory = join(dir, "artifacts");
  async function run() {
    const id = randomUUID();
    db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(id, book, "running", 0, now());
    await executeRun({ db, audit, runId: id, origin: fixture.origin, artifactDirectory });
    return db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  }
  try {
    if (setup) await setup({ fixture, artifactDirectory });
    return await fn({ db, run, fixture, artifactDirectory });
  } finally {
    try { chmodSync(artifactDirectory, 0o700); } catch {}
    await new Promise((r) => fixture.server.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const failures = (db, runId) => db.prepare("SELECT scenario, failure_class, reason_code, evidence_status FROM scenario_results WHERE run_id=? AND status<>'passed' ORDER BY scenario").all(runId);

test("Real Chromium: a page the check cannot drive is automation, leaves the run INCONCLUSIVE, and is not reported as a defect", { timeout: 120000 }, async () => {
  await withFixtureRun(async ({ db, run, fixture }) => {
    fixture.state.label = "Enter"; // a submit label nobody has approved: the control cannot be singled out
    const result = await run();
    assert.equal(result.outcome, "inconclusive", result.summary);
    assert.equal(result.status, "interrupted");
    const rows = failures(db, result.id);
    assert.ok(rows.length >= 1 && rows.every((r) => r.failure_class === "automation" && r.reason_code === "locator_unresolved"), JSON.stringify(rows));
    assert.ok(result.checks_passed >= 1, "the checks that need no submit control still passed");
    assert.match(result.summary, /No check showed Lawcus behaving wrongly, but \d of 5 executed check\(s\) could not complete/);
    for (const { question } of db.prepare("SELECT question FROM clarifications WHERE run_id=?").all(result.id)) {
      assert.match(question, /\[automation: locator_unresolved\]/);
      assert.doesNotMatch(question, /defect/, "an undrivable page is not offered as a possible defect");
    }
  });
});

test("Real Chromium: a fixture that is down is an infrastructure problem, INCONCLUSIVE, never a defect", { timeout: 120000 }, async () => {
  await withFixtureRun(async ({ db, run, fixture }) => {
    await new Promise((r) => fixture.server.close(r)); // the local application goes away
    const result = await run();
    assert.equal(result.outcome, "inconclusive", result.summary);
    const rows = failures(db, result.id);
    assert.ok(rows.length >= 1 && rows.every((r) => r.failure_class === "infrastructure" && r.reason_code === "network_unreachable"), JSON.stringify(rows));
    assert.equal(result.checks_passed, 0);
  });
});

test("Real Chromium: evidence that cannot be saved is an integrity problem: the check is not a pass and the run is INCONCLUSIVE", { timeout: 120000 }, async () => {
  await withFixtureRun(async ({ db, run }) => {
    const result = await run();
    assert.equal(result.outcome, "inconclusive", result.summary);
    assert.equal(result.status, "interrupted");
    const rows = failures(db, result.id);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.failure_class === "integrity" && r.reason_code === "evidence_save_failed" && r.evidence_status === "save_failed"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM artifacts WHERE run_id=?").get(result.id).n, 0);
  }, { setup: ({ artifactDirectory }) => { mkdirSync(artifactDirectory, { recursive: true }); chmodSync(artifactDirectory, 0o500); } });
});
