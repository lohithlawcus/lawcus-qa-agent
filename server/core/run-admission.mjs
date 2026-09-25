// Shared staging run budget, so the app and MCP obey the same limit. Real
// staging logins from the one shared QA account were documented to stall
// after a burst (see executeImpactedTest's comment); this caps how many
// runs may start against one environment in a rolling window.
export const STAGING_RUN_LIMIT = 3;
export const STAGING_RUN_WINDOW_MS = 600000;

export function checkStagingBudget(db, environmentId, { nowMs = Date.now(), limit = STAGING_RUN_LIMIT, windowMs = STAGING_RUN_WINDOW_MS } = {}) {
  const since = new Date(nowMs - windowMs).toISOString();
  const { n } = db
    .prepare("SELECT COUNT(*) n FROM runs JOIN runbooks ON runbooks.id=runs.runbook_id WHERE runbooks.environment_id=? AND runs.started_at>?")
    .get(environmentId, since);
  return { ok: n < limit, recent: n, limit, windowMinutes: Math.round(windowMs / 60000) };
}
