// Shared staging run budget, so the app and MCP obey the same limit. Real
// staging logins from the one shared QA account were documented to stall
// after a burst (see executeImpactedTest's comment); this caps how many
// runs may start against one environment in a rolling window.
export const STAGING_RUN_LIMIT = 3;
export const STAGING_RUN_WINDOW_MS = 600000;

export function checkStagingBudget(db, environmentId, { nowMs = Date.now(), limit = STAGING_RUN_LIMIT, windowMs = STAGING_RUN_WINDOW_MS } = {}) {
  const since = new Date(nowMs - windowMs).toISOString();
  const runs = db
    .prepare("SELECT COUNT(*) n FROM runs JOIN runbooks ON runbooks.id=runs.runbook_id WHERE runbooks.environment_id=? AND runs.started_at>?")
    .get(environmentId, since).n;
  // A sweep signs in to staging too, so it spends the same budget.
  const sweeps = db.prepare("SELECT COUNT(*) n FROM staging_sweeps WHERE environment_id=? AND started_at>?").get(environmentId, since).n;
  const n = runs + sweeps;
  return { ok: n < limit, recent: n, limit, windowMinutes: Math.round(windowMs / 60000) };
}

/** True while a run OR a sweep is using the one shared staging account. */
export function stagingBusy(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM runs WHERE status='running'").get() ||
      db.prepare("SELECT 1 FROM staging_sweeps WHERE status='running'").get(),
  );
}
