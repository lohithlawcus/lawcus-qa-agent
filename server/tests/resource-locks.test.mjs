import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openResourceLocks, LockError } from "../core/resource-locks.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-resource-locks-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openResourceLocks(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
    runbookId, 1, "fixture", "t", "intent", "built-in", JSON.stringify({ scenarios: ["valid_login"] }), new Date().toISOString(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(
    runId, runbookId, "passed", 0, new Date().toISOString(),
  );
  return runId;
}

const KEY = "tenant:qa:custom-fields:contact";

test("acquire succeeds and reports the lock as held", () => {
  withStore((locks, db) => {
    const runId = seedRun(db);
    const lock = locks.acquire({ lockKey: KEY, runId });
    assert.equal(lock.status, "held");
    assert.equal(locks.isHeld(KEY), true);
  });
});

test("a second run cannot acquire the same key while the first holds it — conflicting writes never run concurrently", () => {
  withStore((locks, db) => {
    const runA = seedRun(db);
    const runB = seedRun(db);
    locks.acquire({ lockKey: KEY, runId: runA });
    assert.throws(
      () => locks.acquire({ lockKey: KEY, runId: runB }),
      (e) => e instanceof LockError && e.code === "lock_held",
    );
  });
});

test("after release, a different run can acquire the same key", () => {
  withStore((locks, db) => {
    const runA = seedRun(db);
    const runB = seedRun(db);
    locks.acquire({ lockKey: KEY, runId: runA });
    locks.release({ lockKey: KEY, runId: runA });
    assert.equal(locks.isHeld(KEY), false);
    const second = locks.acquire({ lockKey: KEY, runId: runB });
    assert.equal(second.run_id, runB);
  });
});

test("release refuses to release a lock this run doesn't hold (wrong run, or already released)", () => {
  withStore((locks, db) => {
    const runA = seedRun(db);
    const runB = seedRun(db);
    locks.acquire({ lockKey: KEY, runId: runA });
    assert.throws(
      () => locks.release({ lockKey: KEY, runId: runB }),
      (e) => e instanceof LockError && e.code === "not_held",
    );
    locks.release({ lockKey: KEY, runId: runA });
    assert.throws(() => locks.release({ lockKey: KEY, runId: runA }));
  });
});

test("releaseAllForRun releases every lock this run holds, and nothing belonging to another run", () => {
  withStore((locks, db) => {
    const runA = seedRun(db);
    const runB = seedRun(db);
    locks.acquire({ lockKey: "a", runId: runA });
    locks.acquire({ lockKey: "b", runId: runA });
    locks.acquire({ lockKey: "c", runId: runB });
    const released = locks.releaseAllForRun(runA);
    assert.equal(released, 2);
    assert.equal(locks.isHeld("a"), false);
    assert.equal(locks.isHeld("b"), false);
    assert.equal(locks.isHeld("c"), true);
  });
});

test("releaseAllForRun is a no-op, not an error, for a run holding nothing", () => {
  withStore((locks, db) => {
    const runId = seedRun(db);
    assert.equal(locks.releaseAllForRun(runId), 0);
  });
});

test("recoverStale moves an expired lease to stale_recovered and frees the key for a new acquire", () => {
  withStore((locks, db) => {
    const runA = seedRun(db);
    const runB = seedRun(db);
    // A negative lease is already expired the instant it's acquired —
    // simulates a crashed run's lease running out.
    locks.acquire({ lockKey: KEY, runId: runA, leaseMs: -1000 });
    assert.throws(() => locks.acquire({ lockKey: KEY, runId: runB }));
    const recovered = locks.recoverStale();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].lock_key, KEY);
    const second = locks.acquire({ lockKey: KEY, runId: runB });
    assert.equal(second.run_id, runB);
  });
});

test("recoverStale never touches a lock whose lease hasn't expired", () => {
  withStore((locks, db) => {
    const runId = seedRun(db);
    locks.acquire({ lockKey: KEY, runId, leaseMs: 600000 });
    assert.equal(locks.recoverStale().length, 0);
    assert.equal(locks.isHeld(KEY), true);
  });
});

test("forRun lists every lock a run has ever touched, held or released", () => {
  withStore((locks, db) => {
    const runId = seedRun(db);
    locks.acquire({ lockKey: "a", runId });
    locks.acquire({ lockKey: "b", runId });
    locks.release({ lockKey: "a", runId });
    const rows = locks.forRun(runId);
    assert.equal(rows.length, 2);
  });
});
