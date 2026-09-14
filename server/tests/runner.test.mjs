import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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
      assert.equal(defect.status, "failed");
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
