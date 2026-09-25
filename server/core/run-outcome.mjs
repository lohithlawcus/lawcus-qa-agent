import { now } from "./store.mjs";
import { safeErrorMessage } from "./redact.mjs";
import { CLASS_LABELS, classifyThrown, countByClass } from "./failure-class.mjs";

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

  // Only a functional failure is a claim about Lawcus. A check that could not
  // run (environment, tooling, page automation, recording) leaves the run
  // inconclusive. A result with no class predates classification and counts
  // as functional, so older callers behave as before.
  const byClass = countByClass(executedCells.filter((r) => r.status !== "passed"));
  const functionalFailed = byClass.functional || 0;
  const couldNotComplete = failed - functionalFailed;

  let outcome;
  if (functionalFailed > 0) outcome = "failed";
  else if (couldNotComplete > 0) outcome = "inconclusive";
  else if (executed === 0) outcome = "inconclusive";
  else if (notRun > 0) outcome = "partial";
  else outcome = "passed";

  const status = outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "interrupted";
  const otherBreakdown = Object.entries(byClass)
    .filter(([failureClass]) => failureClass !== "functional")
    .map(([failureClass, count]) => `${count} ${CLASS_LABELS[failureClass]}`)
    .join("; ");
  const summary =
    outcome === "passed"
      ? `${executed} of ${planned} check(s) executed and passed.`
      : outcome === "failed"
        ? `${functionalFailed} of ${executed} executed check(s) failed${notRun ? `; ${notRun} of ${planned} planned check(s) were not run` : ""}${otherBreakdown ? `; ${otherBreakdown}` : ""}.`
        : couldNotComplete > 0
          ? `No check showed Lawcus behaving wrongly, but ${couldNotComplete} of ${executed} executed check(s) could not complete (${otherBreakdown})${passed ? `; ${passed} passed` : ""} — nothing is claimed about the affected checks, so no pass is claimed.`
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
      summary: `The run stopped before finishing (${saved.length} of ${planned ?? "?"} check(s) were recorded): ${safeErrorMessage(error, 300)}. ${(() => { const c = classifyThrown(error); return `Classified as ${c.failureClass} (${c.reasonCode}): ${c.explanation}`; })()} No pass is claimed.`,
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

/** Finalizes a run whose per-check results were written to scenario_results as
 * it went (the browser-driven Login suite). Reads them back, so the verdict
 * comes from what was really recorded, and treats planned checks that never got
 * a row as not run. Same rules as every other run: only a functional failure
 * fails it, and anything not fully executed is never a pass. */
export function finalizeFromSavedResults(db, runId, { planned, extraSummary = "" }) {
  const results = db
    .prepare("SELECT status, failure_class FROM scenario_results WHERE run_id=?")
    .all(runId)
    .map((row) => ({ executed: true, status: row.status, failureClass: row.failure_class }));
  while (results.length < planned) results.push({ executed: false });
  return finalizeRun(db, runId, { results, extraSummary });
}

/** Finalizes a run the operator cancelled: the counts come from what was really
 * recorded, and no result is claimed for checks that never started. 'cancelled'
 * is an outcome of its own, not a pass, a failure or an inconclusive run. */
export function finalizeCancelledRun(db, runId, { planned }) {
  const rows = db.prepare("SELECT status FROM scenario_results WHERE run_id=?").all(runId);
  const passed = rows.filter((row) => row.status === "passed").length;
  const summary = `Run cancelled by the operator after ${rows.length} of ${planned} checks. No result is claimed for the checks that had not started.`;
  db.prepare(
    "UPDATE runs SET status='cancelled',outcome='cancelled',checks_planned=?,checks_executed=?,checks_passed=?,checks_failed=?,finished_at=?,summary=? WHERE id=?",
  ).run(planned, rows.length, passed, rows.length - passed, now(), summary, runId);
  return { planned, executed: rows.length, passed, failed: rows.length - passed, outcome: "cancelled", status: "cancelled", summary };
}
