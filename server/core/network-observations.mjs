import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 11 — persistence for correlateObservation() results
// (network-observer.mjs) and captured console/page errors. Purely a
// recorder: it never decides pass/fail itself — the caller (live-runner.mjs)
// reads a recorded observation's contractMatch/cardinalityOk to decide
// whether a scenario should fail, matching section 3.3's "test separately."

export function openNetworkObservations(db, audit) {
  function record({
    runId,
    scenarioResultId = null,
    stepLabel,
    contractId,
    semanticId,
    expectedCardinality,
    result,
  }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO network_observations(
         id,run_id,scenario_result_id,step_label,contract_id,semantic_id,
         expected_cardinality,observed_count,cardinality_ok,contract_match,
         mismatch_reason,request_summaries,response_summaries,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      runId,
      scenarioResultId,
      stepLabel,
      contractId,
      semanticId,
      expectedCardinality,
      result.observedCount,
      result.cardinalityOk ? 1 : 0,
      result.contractMatch ? 1 : 0,
      result.mismatchReason,
      JSON.stringify(result.matchResults.map((m) => m.requestSummary)),
      JSON.stringify(result.matchResults.map((m) => m.responseSummary)),
      now(),
    );
    audit?.("network_observation.recorded", id, {
      runId,
      semanticId,
      cardinalityOk: result.cardinalityOk,
      contractMatch: result.contractMatch,
    });
    return db.prepare("SELECT * FROM network_observations WHERE id=?").get(id);
  }

  function recordConsoleEntries({ runId, scenarioResultId = null, entries }) {
    const insert = db.prepare(
      "INSERT INTO console_observations(id,run_id,scenario_result_id,level,message,created_at) VALUES(?,?,?,?,?,?)",
    );
    for (const entry of entries) insert.run(randomUUID(), runId, scenarioResultId, entry.level, entry.message, now());
  }

  function forRun(runId) {
    return {
      network: db.prepare("SELECT * FROM network_observations WHERE run_id=? ORDER BY created_at").all(runId),
      console: db.prepare("SELECT * FROM console_observations WHERE run_id=? ORDER BY created_at").all(runId),
    };
  }

  return { record, recordConsoleEntries, forRun };
}
