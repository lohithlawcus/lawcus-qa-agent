// A read-only report of what the run history actually supports: which checks
// count as coverage right now, when each last ran, and how much of the failure
// signal is about Lawcus rather than the environment or the tool.
//
// It changes nothing and reads only tables that already exist. Every figure
// carries its denominator, and the history includes runs made while the tool
// was being built, so the metrics are a baseline to compare against later, not
// a pass rate for today's code.

/** The tenant a check's coverage is judged on. Other tenants are reported as information. */
export const COVERAGE_ENVIRONMENT = "lawcus";
export const STALE_AFTER_DAYS = 14;
export const WINDOW_DAYS = 90;

// A result counts toward coverage when it passed, or failed in a way that says Lawcus
// (or the check's expectation) was wrong. A failure the tool has since classified as the
// environment, the tool or storage does not count either way. Failures recorded before
// classification existed have no class; nothing says they were environmental, so they count.
const isConclusive = (row) => row.status === "passed" || (row.status === "failed" && (row.failure_class == null || row.failure_class === "functional"));

export const COVERAGE_STATES = {
  covered: "Passed on staging recently, and the last result that counts is a pass.",
  stale: "The last result that counts is a pass, but it is old.",
  failing: "The last result that counts is a failure. Failures recorded before the tool classified them count, because nothing says they were environmental.",
  inconclusive: "It has run on staging, but never conclusively (every attempt was blocked by the environment, the tool or storage, so nothing counts).",
  never_run_on_staging: "Approved, but never run on the main staging tenant.",
  quarantined: "Known-broken automation. Not counted as coverage.",
  not_approved: "Not approved (pending or deprecated). Not counted as coverage.",
};

const DAY_MS = 86400000;
const ageDays = (iso, nowMs) => Math.floor((nowMs - Date.parse(iso)) / DAY_MS);

export function buildCoverageReport(db, { nowMs = Date.now(), staleAfterDays = STALE_AFTER_DAYS, windowDays = WINDOW_DAYS } = {}) {
  const cases = db
    .prepare(
      `SELECT c.id, c.external_id, c.title, c.status, c.automation_readiness, c.quarantine_reason, f.name AS feature
       FROM test_cases c JOIN test_suites s ON s.id=c.suite_id JOIN features f ON f.id=s.feature_id
       ORDER BY f.name, c.external_id`,
    )
    .all();

  const resultsFor = db.prepare(
    `SELECT r.status, r.failure_class, r.reason_code, u.started_at, u.code_revision, u.outcome, b.environment_id
     FROM scenario_results r JOIN runs u ON u.id=r.run_id JOIN runbooks b ON b.id=u.runbook_id
     WHERE r.test_case_id=? ORDER BY u.started_at DESC`,
  );

  const rows = cases.map((c) => {
    const results = resultsFor.all(c.id);
    const main = results.filter((r) => r.environment_id === COVERAGE_ENVIRONMENT);
    const lastAttempt = main[0] ?? null;
    const lastConclusive = main.find(isConclusive) ?? null;

    let state;
    if (c.status !== "approved") state = "not_approved";
    else if (c.automation_readiness === "quarantined") state = "quarantined";
    else if (main.length === 0) state = "never_run_on_staging";
    else if (!lastConclusive) state = "inconclusive";
    else if (lastConclusive.status === "failed") state = "failing";
    else state = ageDays(lastConclusive.started_at, nowMs) > staleAfterDays ? "stale" : "covered";

    const otherEnvironments = {};
    for (const r of results) {
      if (r.environment_id === COVERAGE_ENVIRONMENT || otherEnvironments[r.environment_id]) continue;
      otherEnvironments[r.environment_id] = { at: r.started_at, status: r.status, failureClass: r.failure_class ?? null };
    }
    const brief = (r) => r && { at: r.started_at, ageDays: ageDays(r.started_at, nowMs), status: r.status, failureClass: r.failure_class ?? null, reasonCode: r.reason_code ?? null, codeRevision: r.code_revision ?? null };
    return {
      externalId: c.external_id,
      title: c.title,
      feature: c.feature,
      state,
      countsAsCoverage: state === "covered",
      // A newer attempt the environment or tool blocked: the pass above still stands, but it is not the latest word.
      newerInconclusiveAttempt: Boolean(lastAttempt && lastConclusive && lastAttempt !== lastConclusive),
      quarantineReason: c.automation_readiness === "quarantined" ? c.quarantine_reason : null,
      stagingRuns: main.length,
      lastAttempt: brief(lastAttempt),
      lastConclusive: brief(lastConclusive),
      otherEnvironments,
    };
  });

  const byState = Object.fromEntries(Object.keys(COVERAGE_STATES).map((k) => [k, 0]));
  for (const r of rows) byState[r.state] += 1;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    environment: COVERAGE_ENVIRONMENT,
    staleAfterDays,
    states: COVERAGE_STATES,
    summary: { cases: rows.length, byState, coveredCases: byState.covered },
    cases: rows,
    quality: buildQuality(db, { nowMs, windowDays }),
  };
}

function buildQuality(db, { nowMs, windowDays }) {
  const since = new Date(nowMs - windowDays * DAY_MS).toISOString();
  // Real tenants only: the local fixture is the tool testing itself.
  const results = db
    .prepare(
      `SELECT r.test_case_id, r.status, r.failure_class, u.started_at, u.code_revision, b.environment_id
       FROM scenario_results r JOIN runs u ON u.id=r.run_id JOIN runbooks b ON b.id=u.runbook_id
       WHERE b.environment_id<>'fixture' AND u.started_at>=? ORDER BY u.started_at`,
    )
    .all(since);

  const failed = results.filter((r) => r.status === "failed");
  const byClass = { functional: 0, infrastructure: 0, automation: 0, integrity: 0, unclassified: 0, unlabelled: 0 };
  for (const r of failed) byClass[r.failure_class && r.failure_class in byClass ? r.failure_class : "unlabelled"] += 1;
  const skipped = results.filter((r) => r.status !== "passed" && r.status !== "failed").length;

  const runs = db
    .prepare(
      `SELECT u.outcome, COUNT(*) n FROM runs u JOIN runbooks b ON b.id=u.runbook_id
       WHERE b.environment_id<>'fixture' AND u.started_at>=? GROUP BY u.outcome`,
    )
    .all(since);
  const runOutcomes = {};
  for (const r of runs) runOutcomes[r.outcome ?? "not_recorded"] = r.n;

  // Flaky: the same check on the same tenant, on the same code revision, both passed and failed conclusively.
  const seen = new Map();
  for (const r of results) {
    if (!r.code_revision || !isConclusive(r)) continue;
    const key = `${r.test_case_id}|${r.environment_id}|${r.code_revision}`;
    const set = seen.get(key) ?? new Set();
    set.add(r.status);
    seen.set(key, set);
  }
  const flaky = [...seen].filter(([, set]) => set.size === 2).map(([key]) => key.split("|")[0]);
  const idToExternal = new Map(db.prepare("SELECT id, external_id FROM test_cases").all().map((c) => [c.id, c.external_id]));

  const share = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return {
    windowDays,
    note: "Includes runs made while the tool was being built and runs on older code. A baseline to compare against, not today's pass rate. Fixture runs are excluded.",
    checks: {
      executed: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed: failed.length,
      neitherPassedNorFailed: skipped,
    },
    failuresByClass: byClass,
    // Of the checks that failed, how many say Lawcus behaved wrongly. Old results have no class.
    functionalShareOfFailures: share(byClass.functional, failed.length - byClass.unlabelled),
    functionalShareBasis: failed.length - byClass.unlabelled,
    runOutcomes,
    flakyCases: [...new Set(flaky)].map((id) => idToExternal.get(id) ?? id).sort(),
  };
}
