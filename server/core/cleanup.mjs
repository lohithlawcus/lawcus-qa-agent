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

    const overall = failed.length || restorationFailed.length ? "needs_review" : "passed";
    return { overall, deleted, failed, restored, restorationFailed };
  }

  return { runCleanup };
}
