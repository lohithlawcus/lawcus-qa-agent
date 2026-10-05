import { createHash, randomBytes, randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";
import { redactValue } from "../core/redact.mjs";

export const AI_POLICY_VERSION = "ai-gate-v2";
export const AI_FAILURE_WINDOW_MS = 10 * 60_000;
export const AI_FAILURE_LIMIT = 3;
export const AI_HOURLY_LIMIT = 20;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function entryHash(row) {
  return hash({
    id: row.id, gate_request_id: row.gate_request_id, phase: row.phase,
    task: row.task, requester: row.requester, provider: row.provider,
    model: row.model, policy_version: row.policy_version,
    input_salt: row.input_salt, input_hash: row.input_hash,
    output_hash: row.output_hash, error_code: row.error_code,
    previous_hash: row.previous_hash, created_at: row.created_at,
  });
}

export function openAiSafety(db, audit) {
  function append({ gateRequestId, phase, task, requester, provider = null, model = null, input, output = null, errorCode = null }) {
    const previous = db.prepare("SELECT entry_hash FROM ai_decision_ledger ORDER BY sequence DESC LIMIT 1").get()?.entry_hash ?? null;
    const inputSalt = randomBytes(16).toString("hex");
    const row = {
      id: randomUUID(), gate_request_id: gateRequestId, phase, task, requester,
      provider, model, policy_version: AI_POLICY_VERSION, input_salt: inputSalt,
      input_hash: hash([inputSalt, redactValue(input ?? null)]),
      output_hash: output == null ? null : hash([inputSalt, redactValue(output)]),
      error_code: errorCode, previous_hash: previous, created_at: now(),
    };
    db.prepare(
      `INSERT INTO ai_decision_ledger(id,gate_request_id,phase,task,requester,provider,model,policy_version,input_salt,input_hash,output_hash,error_code,previous_hash,entry_hash,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id, row.gate_request_id, row.phase, row.task, row.requester,
      row.provider, row.model, row.policy_version, row.input_salt,
      row.input_hash, row.output_hash, row.error_code, row.previous_hash,
      entryHash(row), row.created_at,
    );
  }

  function verifyLedger() {
    const rows = db.prepare(
      `SELECT l.*,r.allowed AS request_allowed,r.error_code AS request_error_code
       FROM ai_decision_ledger l LEFT JOIN ai_gate_requests r ON r.id=l.gate_request_id
       ORDER BY l.sequence`,
    ).all();
    let previous = null;
    const latestByRequest = new Map();
    for (const row of rows) {
      if (row.previous_hash !== previous || row.entry_hash !== entryHash(row))
        return { intact: false, records: rows.length, firstInvalidSequence: row.sequence };
      previous = row.entry_hash;
      latestByRequest.set(row.gate_request_id, row);
    }
    for (const row of latestByRequest.values()) {
      const expectedAllowed = row.phase === "completed" ? 1 : 0;
      const expectedError = row.phase === "started" ? "in_flight" : row.phase === "completed" ? null : row.error_code;
      if (row.request_allowed !== expectedAllowed || row.request_error_code !== expectedError)
        return { intact: false, records: rows.length, firstInvalidSequence: row.sequence };
    }
    return { intact: true, records: rows.length, firstInvalidSequence: null };
  }

  function isCircuitOpen() {
    return Boolean(db.prepare("SELECT circuit_open FROM ai_safety_state WHERE id=1").get().circuit_open);
  }

  function trip(reasonCode, gateRequestId = null, severity = "high") {
    if (isCircuitOpen()) return false;
    const openedAt = now();
    const incidentId = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE ai_safety_state SET circuit_open=1,reason_code=?,opened_at=?,reset_at=NULL,reset_by=NULL WHERE id=1")
        .run(reasonCode, openedAt);
      db.prepare("INSERT INTO ai_safety_incidents(id,severity,reason_code,gate_request_id,opened_at) VALUES(?,?,?,?,?)")
        .run(incidentId, severity, reasonCode, gateRequestId, openedAt);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit?.("ai_gate.circuit_opened", incidentId, { reasonCode, gateRequestId });
    return true;
  }

  function reset(by) {
    if (!isCircuitOpen()) return;
    const at = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE ai_safety_state SET circuit_open=0,reset_at=?,reset_by=? WHERE id=1").run(at, by);
      db.prepare("UPDATE ai_safety_incidents SET status='closed',closed_at=?,closed_by=? WHERE status='open' AND reason_code=(SELECT reason_code FROM ai_safety_state WHERE id=1)")
        .run(at, by);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit?.("ai_gate.circuit_reset", "ai_safety_state", { by });
  }

  function recentFailures() {
    const since = new Date(Date.now() - AI_FAILURE_WINDOW_MS).toISOString();
    return db.prepare("SELECT COUNT(*) AS n FROM ai_decision_ledger WHERE phase='failed' AND error_code IN ('provider_failure','invalid_model_output') AND created_at>=?").get(since).n;
  }

  function hourlyCalls() {
    const since = new Date(Date.now() - 3600_000).toISOString();
    return db.prepare("SELECT COUNT(*) AS n FROM ai_decision_ledger WHERE phase='started' AND created_at>=?").get(since).n;
  }

  function summary() {
    return {
      circuit: db.prepare("SELECT * FROM ai_safety_state WHERE id=1").get(),
      ledger: verifyLedger(),
      incidents: db.prepare("SELECT * FROM ai_safety_incidents ORDER BY opened_at DESC LIMIT 20").all(),
      risks: db.prepare("SELECT * FROM ai_residual_risks ORDER BY id").all(),
      hourlyCalls: hourlyCalls(),
      hourlyLimit: AI_HOURLY_LIMIT,
    };
  }

  return { append, verifyLedger, isCircuitOpen, trip, reset, recentFailures, hourlyCalls, summary };
}
