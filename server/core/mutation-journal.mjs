import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 13 / section 27 — Mutation / Restoration Journal. Exact-ID
// deletion (resource-ownership.mjs) handles resources a run CREATES; it
// says nothing about a run MODIFYING something that already existed
// (renaming a Custom Field, changing a workflow step, ...). Before such a
// mutation, the relevant before-state must be captured here so it can be
// restored afterward — restoration is a separate, auditable outcome from
// the test result itself (section 28: "never hide the original test
// result").

export class MutationJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function openMutationJournal(db, audit) {
  function recordBeforeState({
    runId,
    environmentId,
    resourceType,
    resourceId,
    resourceVersion = null,
    beforeState,
    primitiveId,
    restorationStrategy,
  }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO mutation_journal(
         id,run_id,environment_id,resource_type,resource_id,resource_version,
         before_state,primitive_id,restoration_strategy,restoration_status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      runId,
      environmentId,
      resourceType,
      resourceId,
      resourceVersion,
      JSON.stringify(beforeState),
      primitiveId,
      restorationStrategy,
      "pending",
      now(),
    );
    audit?.("mutation.journaled", id, { runId, resourceType, resourceId });
    return { ...db.prepare("SELECT * FROM mutation_journal WHERE id=?").get(id), beforeState };
  }

  function recordRestoration(id, { status, note = null }) {
    const result = db
      .prepare(
        "UPDATE mutation_journal SET restoration_status=?,restoration_note=?,restored_at=? WHERE id=? AND restoration_status='pending'",
      )
      .run(status, note, now(), id);
    if (!result.changes)
      throw new MutationJournalError("not_pending", "This mutation journal entry is not awaiting restoration.");
    audit?.("mutation.restoration_recorded", id, { status });
    return db.prepare("SELECT * FROM mutation_journal WHERE id=?").get(id);
  }

  /** LIFO by default (section 27: "reverse dependency order where
   * relevant") — undo the most recent change first, the closest thing to
   * a general-purpose safe default when entries don't declare an explicit
   * dependency between each other. */
  function pendingRestorationsForRun(runId) {
    return db
      .prepare("SELECT * FROM mutation_journal WHERE run_id=? AND restoration_status='pending' ORDER BY created_at DESC")
      .all(runId)
      .map((row) => ({ ...row, before_state: JSON.parse(row.before_state) }));
  }

  function forRun(runId) {
    return db
      .prepare("SELECT * FROM mutation_journal WHERE run_id=? ORDER BY created_at")
      .all(runId)
      .map((row) => ({ ...row, before_state: JSON.parse(row.before_state) }));
  }

  return { recordBeforeState, recordRestoration, pendingRestorationsForRun, forRun };
}
