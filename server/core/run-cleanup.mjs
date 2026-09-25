// Runs cleanup for a finished run and records the result on the run, so a
// run started from the app or through MCP is closed out the same way. It
// never changes the run's own pass/fail (runs.status); cleanup has its own
// column, and anything left behind is stated in the run's summary.
export async function closeOutCleanup({ db, cleanupRunner, runId, audit }) {
  // No cleanup runner available (e.g. a minimal test context): leave
  // cleanup_status NULL — "unknown" — rather than claim it passed.
  if (!cleanupRunner) return null;
  let result;
  try {
    result = await cleanupRunner.runCleanup({ runId, deleteHandlers: {}, restoreHandlers: {} });
  } catch {
    db.prepare("UPDATE runs SET cleanup_status='failed' WHERE id=?").run(runId);
    audit?.("run.cleanup-failed", runId, {});
    return { overall: "failed", leftovers: [], restorationFailed: [] };
  }
  const notes = [];
  if (result.leftovers.length)
    notes.push(`${result.leftovers.length} record(s) created by this run remain in staging and need manual cleanup.`);
  if (result.restorationFailed.length)
    notes.push(`${result.restorationFailed.length} field change(s) may not have been restored.`);
  db.prepare("UPDATE runs SET cleanup_status=?, summary=CASE WHEN ?='' THEN summary ELSE COALESCE(summary,'') || ' ' || ? END WHERE id=?")
    .run(result.overall, notes.join(" "), notes.join(" "), runId);
  audit?.("run.cleanup-completed", runId, { overall: result.overall, leftovers: result.leftovers.length });
  return result;
}
