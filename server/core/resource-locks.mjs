import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 13 / section 26 — Resource Lock Manager. Shared/global Lawcus
// configuration (Custom Field definitions, Roles & Permissions, workflow
// definitions, billing settings, ...) isn't protected by resource
// ownership at all — two runs can both "own" nothing and still collide by
// editing the same shared setting. A semantic lock key
// (e.g. "tenant:<id>:custom-fields:contact") makes that collision
// impossible at the database level: resource_locks_active_key is a
// partial UNIQUE index on (lock_key) WHERE status='held', so a second
// acquire attempt is refused by SQLite itself, not by application-level
// care that could have a race in it.

export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export function openResourceLocks(db, audit) {
  function acquire({ lockKey, runId, leaseMs = DEFAULT_LEASE_MS }) {
    const id = randomUUID();
    const acquiredAt = now();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    try {
      db.prepare(
        "INSERT INTO resource_locks(id,lock_key,run_id,status,acquired_at,lease_expires_at) VALUES(?,?,?,?,?,?)",
      ).run(id, lockKey, runId, "held", acquiredAt, leaseExpiresAt);
    } catch {
      throw new LockError("lock_held", `Resource lock "${lockKey}" is currently held by another run.`);
    }
    audit?.("lock.acquired", id, { lockKey, runId, leaseExpiresAt });
    return db.prepare("SELECT * FROM resource_locks WHERE id=?").get(id);
  }

  function release({ lockKey, runId }) {
    const result = db
      .prepare("UPDATE resource_locks SET status='released',released_at=? WHERE lock_key=? AND run_id=? AND status='held'")
      .run(now(), lockKey, runId);
    if (!result.changes) throw new LockError("not_held", `Lock "${lockKey}" is not currently held by this run.`);
    audit?.("lock.released", lockKey, { runId });
  }

  /** Cancellation-safe: releases every lock this run holds, regardless of
   * key, without the caller needing to remember which locks it took
   * (section 26: "cancellation releases safely"). Never throws for a run
   * holding nothing. */
  function releaseAllForRun(runId) {
    const held = db.prepare("SELECT lock_key FROM resource_locks WHERE run_id=? AND status='held'").all(runId);
    for (const row of held) release({ lockKey: row.lock_key, runId });
    return held.length;
  }

  /** A lease that expired without being released (a crashed/interrupted
   * run) is recoverable — moved to 'stale_recovered' so a new run can
   * acquire the same key, matching section 26: "stale leases are
   * recoverable." Returns the rows it recovered. */
  function recoverStale() {
    const stale = db.prepare("SELECT * FROM resource_locks WHERE status='held' AND lease_expires_at<?").all(now());
    for (const row of stale)
      db.prepare("UPDATE resource_locks SET status='stale_recovered',released_at=? WHERE id=?").run(now(), row.id);
    for (const row of stale) audit?.("lock.stale_recovered", row.id, { lockKey: row.lock_key, previousRunId: row.run_id });
    return stale;
  }

  function isHeld(lockKey) {
    return Boolean(db.prepare("SELECT 1 FROM resource_locks WHERE lock_key=? AND status='held'").get(lockKey));
  }

  function forRun(runId) {
    return db.prepare("SELECT * FROM resource_locks WHERE run_id=? ORDER BY acquired_at").all(runId);
  }

  return { acquire, release, releaseAllForRun, recoverStale, isHeld, forRun };
}
