import { now } from "./store.mjs";

// One place that decides what a finished run's status means, used by the
// app's impacted-test route and by the MCP run tools. A run is "passed"
// only when every planned check actually executed and passed. A run that
// executed nothing, ran only some of its checks, or died partway is never
// green: it is stored as 'interrupted' ("no pass is claimed"), and the
// counts say exactly what happened. (runs.status keeps its legacy CHECK —
// see migration 020 for why there is no 'inconclusive' status value.)

/** Pure: derives counts + verdict from per-check results
 *  ({executed: boolean, status: "passed"|"failed"|...}). */
export function summarizeCells(results) {
  const planned = results.length;
  const executedCells = results.filter((r) => r.executed);
  const executed = executedCells.length;
  const passed = executedCells.filter((r) => r.status === "passed").length;
  const failed = executedCells.filter((r) => r.status !== "passed").length;
  const notRun = planned - executed;

  let outcome;
  if (failed > 0) outcome = "failed";
  else if (executed === 0) outcome = "inconclusive";
  else if (notRun > 0) outcome = "partial";
  else outcome = "passed";

  const status = outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "interrupted";
  const summary =
    outcome === "passed"
      ? `${executed} of ${planned} check(s) executed and passed.`
      : outcome === "failed"
        ? `${failed} of ${executed} executed check(s) failed${notRun ? `; ${notRun} of ${planned} planned check(s) were not run` : ""}.`
        : outcome === "inconclusive"
          ? `0 of ${planned} planned check(s) executed — nothing was verified, so no pass is claimed.`
          : `${passed} of ${executed} executed check(s) passed, but ${notRun} of ${planned} planned check(s) were not run (unapproved, quarantined or missing) — no overall pass is claimed.`;
  return { planned, executed, passed, failed, notRun, outcome, status, summary };
}

/** Writes the final verdict for a run. `results` are the per-check
 *  results if execution returned normally; `error` (with `planned`) if it
 *  threw — in which case the counts come from what was actually saved, and
 *  the run is never green. */
export function finalizeRun(db, runId, { results = null, planned = null, error = null, extraSummary = "" } = {}) {
  let verdict;
  if (error) {
    const saved = db.prepare("SELECT status FROM scenario_results WHERE run_id=?").all(runId);
    const passed = saved.filter((r) => r.status === "passed").length;
    const failed = saved.length - passed;
    verdict = {
      planned: planned ?? saved.length,
      executed: saved.length,
      passed,
      failed,
      outcome: "inconclusive",
      status: "interrupted",
      summary: `The run stopped before finishing (${saved.length} of ${planned ?? "?"} check(s) were recorded): ${String(error.message ?? error).slice(0, 300)}. No pass is claimed.`,
    };
  } else {
    verdict = summarizeCells(results ?? []);
  }
  db.prepare(
    "UPDATE runs SET status=?,outcome=?,checks_planned=?,checks_executed=?,checks_passed=?,checks_failed=?,finished_at=?,summary=? WHERE id=?",
  ).run(
    verdict.status, verdict.outcome, verdict.planned, verdict.executed, verdict.passed, verdict.failed,
    now(), extraSummary ? `${verdict.summary} ${extraSummary}` : verdict.summary, runId,
  );
  return verdict;
}
