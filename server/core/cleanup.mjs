// V5 Step 13 / section 28 — Cleanup. Runs after every run — pass, failure,
// cancellation, or interruption recovery (the caller is responsible for
// invoking this in all four cases; see server/index.mjs's run completion
// handling). This never changes the test's own result: it computes and
// records a SEPARATE outcome (section 28's "TEST RESULT failed / CLEANUP
// passed" example), which the caller stores on runs.cleanup_status.
//
// deleteHandlers/restoreHandlers are keyed by resource_type, supplied by
// whatever feature actually knows how to delete/restore its own resources
// — this module has no feature-specific knowledge. Until a real mutating
// feature exists (Step 15's Contacts/Custom Fields/Leads milestone), both
// maps are empty and this runs as a real, honest no-op: nothing was
// created or mutated, so there is nothing pending to skip.

export function createCleanupRunner({ resourceOwnership, mutationJournal, resourceLocks }) {
  async function runCleanup({ runId, deleteHandlers = {}, restoreHandlers = {} }) {
    const deleted = [];
    const failed = [];
    const restored = [];
    const restorationFailed = [];

    for (const resource of resourceOwnership.pendingCleanupForRun(runId)) {
      const handler = deleteHandlers[resource.resource_type];
      if (!handler) {
        resourceOwnership.markCleanup(resource.id, {
          status: "skipped",
          note: `No cleanup handler is registered for resource type "${resource.resource_type}".`,
        });
        failed.push(resource);
        continue;
      }
      try {
        const outcome = await handler(resource);
        resourceOwnership.markCleanup(resource.id, {
          status: outcome?.alreadyMissing ? "already_missing" : "cleaned",
          note: outcome?.note ?? null,
        });
        deleted.push(resource);
      } catch (error) {
        resourceOwnership.markCleanup(resource.id, {
          status: "failed",
          note: error instanceof Error ? error.message : "Cleanup failed.",
        });
        failed.push(resource);
      }
    }

    for (const entry of mutationJournal.pendingRestorationsForRun(runId)) {
      const handler = restoreHandlers[entry.resource_type];
      if (!handler) {
        mutationJournal.recordRestoration(entry.id, {
          status: "skipped",
          note: `No restoration handler is registered for resource type "${entry.resource_type}".`,
        });
        restorationFailed.push(entry);
        continue;
      }
      try {
        await handler(entry);
        mutationJournal.recordRestoration(entry.id, { status: "restored" });
        restored.push(entry);
      } catch (error) {
        mutationJournal.recordRestoration(entry.id, {
          status: "failed",
          note: error instanceof Error ? error.message : "Restoration failed.",
        });
        restorationFailed.push(entry);
      }
    }

    resourceLocks.releaseAllForRun(runId);

    // "Passed" must mean nothing this run created is still sitting in
    // staging. Records set to manual cleanup (the default for QA-created
    // records until deletion is explicitly authorized) are never touched
    // here, and they are exactly what "passed" used to hide: a registry
    // with nothing recorded, or only manual entries, looked clean.
    const leftovers = resourceOwnership.leftoversForRun(runId);
    const overall = leftovers.length || failed.length || restorationFailed.length ? "needs_review" : "passed";
    return { overall, deleted, failed, restored, restorationFailed, leftovers };
  }

  /** Carries out deletions a person has approved (resource-ownership.mjs's
   * approveDeletion). Only approved, still-pending records are touched, in
   * dependency order. A record whose type has no delete handler is left
   * approved and pending — not marked skipped — so the approval waits for a
   * handler instead of being consumed. Each delete is recorded on its own
   * row; one failure does not stop the rest. */
  async function runApprovedDeletions({ deleteHandlers = {}, environmentId = null, limit = Infinity }) {
    const deleted = [];
    const failed = [];
    const waiting = [];
    let attempted = 0;
    for (const resource of resourceOwnership.approvedForDeletion(environmentId)) {
      if (attempted >= limit) break;
      const handler = deleteHandlers[resource.resource_type];
      if (!handler) {
        waiting.push(resource);
        continue;
      }
      attempted += 1;
      try {
        const outcome = await handler(resource);
        resourceOwnership.markCleanup(resource.id, {
          status: outcome?.alreadyMissing ? "already_missing" : "cleaned",
          note: outcome?.note ?? "Deleted after approval.",
        });
        deleted.push(resource);
      } catch (error) {
        resourceOwnership.markCleanup(resource.id, {
          status: "failed",
          note: error instanceof Error ? error.message : "Deletion failed.",
        });
        failed.push(resource);
      }
    }
    return { deleted, failed, waiting };
  }

  return { runCleanup, runApprovedDeletions };
}
