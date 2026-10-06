// Shared staging run budget, so the app and MCP obey the same limit. Real
// staging logins from the one shared QA account were documented to stall
// after a burst (see executeImpactedTest's comment); this caps how many
// runs may start against one environment in a rolling window.
export const STAGING_RUN_LIMIT = 3;
export const STAGING_RUN_WINDOW_MS = 600000;

export function checkStagingBudget(db, environmentId, { nowMs = Date.now(), limit = STAGING_RUN_LIMIT, windowMs = STAGING_RUN_WINDOW_MS } = {}) {
  const since = new Date(nowMs - windowMs).toISOString();
  // Counted in sign-ins, not runs: a five-case native suite signs in five times, and every
  // sweep, deletion and check does too. Each sign-in is recorded under its lease.
  const n = db.prepare("SELECT COUNT(*) n FROM staging_sign_ins WHERE environment_id=? AND attempted_at>?").get(environmentId, since).n;
  return { ok: n < limit, recent: n, limit, windowMinutes: Math.round(windowMs / 60000) };
}

/** True while any staging operation holds the lease, or a run or sweep is still marked running. */
export function stagingBusy(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM staging_leases WHERE status='active'").get() ||
      db.prepare("SELECT 1 FROM runs WHERE status='running'").get() ||
      db.prepare("SELECT 1 FROM staging_sweeps WHERE status='running'").get(),
  );
}
