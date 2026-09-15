import { randomUUID } from "node:crypto";
import { z } from "zod";
import { now } from "./store.mjs";

export const AuthoringSessionRequest = z
  .object({
    environmentId: z.enum(["fixture", "lawcus"]),
    personaId: z.string().uuid().optional(),
    featureName: z.string().trim().min(1).max(80),
    workflowDescription: z.string().trim().min(3).max(300),
  })
  .strict();
export const AuthoringDiscardRequest = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

// V5 Step 14 / section 29.9 — Recorder audit. Persistence only; this
// module has no opinion about browser control or matching — see
// recorder.mjs for the capture/normalize/match logic and
// live-runner.mjs's startAuthoringSession() for the controlled browser.

export class AuthoringSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function openAuthoringSessions(db, audit) {
  function start({ operator, environmentId, personaId = null, featureName, workflowDescription }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO authoring_sessions(
         id,operator,environment_id,persona_id,feature_name,workflow_description,status,started_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(id, operator, environmentId, personaId, featureName, workflowDescription, "open", now());
    audit?.("authoring_session.started", id, { operator, environmentId, personaId, featureName });
    return db.prepare("SELECT * FROM authoring_sessions WHERE id=?").get(id);
  }

  function recordAction(sessionId, { sequence, actionType, locatorCandidate, locatorQuality, redacted, valueSummary = null, valueLiteral = null }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO authoring_candidate_actions(
         id,session_id,sequence,action_type,locator_candidate,locator_quality,
         redacted,value_summary,value_literal,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      sessionId,
      sequence,
      actionType,
      JSON.stringify(locatorCandidate),
      locatorQuality,
      redacted ? 1 : 0,
      valueSummary,
      // section 29.3: a redacted action's literal value is never written,
      // regardless of what the caller passes — this is the one place that
      // guarantee is actually enforced at rest, not just upstream.
      redacted ? null : valueLiteral,
      now(),
    );
    return id;
  }

  function recordNetworkObservation(sessionId, { method, host, path, status, requestSummary, responseSummary }) {
    db.prepare(
      `INSERT INTO authoring_network_observations(
         id,session_id,method,host,path,status,request_summary,response_summary,observed_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), sessionId, method, host, path, status ?? null, JSON.stringify(requestSummary), responseSummary ? JSON.stringify(responseSummary) : null, now());
  }

  function complete(id, { proposalIds }) {
    const result = db
      .prepare("UPDATE authoring_sessions SET status='completed',ended_at=?,proposal_ids=? WHERE id=? AND status='open'")
      .run(now(), JSON.stringify(proposalIds), id);
    if (!result.changes) throw new AuthoringSessionError("not_open", "This authoring session is not open.");
    audit?.("authoring_session.completed", id, { proposalCount: proposalIds.length });
    return db.prepare("SELECT * FROM authoring_sessions WHERE id=?").get(id);
  }

  function discard(id, reason) {
    const result = db
      .prepare("UPDATE authoring_sessions SET status='discarded',ended_at=?,discard_reason=? WHERE id=? AND status='open'")
      .run(now(), reason ?? null, id);
    if (!result.changes) throw new AuthoringSessionError("not_open", "This authoring session is not open.");
    audit?.("authoring_session.discarded", id, { reason });
    return db.prepare("SELECT * FROM authoring_sessions WHERE id=?").get(id);
  }

  function fail(id, reason) {
    db.prepare("UPDATE authoring_sessions SET status='failed',ended_at=?,discard_reason=? WHERE id=? AND status='open'").run(
      now(),
      reason ?? null,
      id,
    );
    audit?.("authoring_session.failed", id, { reason });
  }

  function get(id) {
    return db.prepare("SELECT * FROM authoring_sessions WHERE id=?").get(id);
  }

  function actionsFor(id) {
    return db
      .prepare("SELECT * FROM authoring_candidate_actions WHERE session_id=? ORDER BY sequence")
      .all(id)
      .map((row) => ({ ...row, locator_candidate: JSON.parse(row.locator_candidate) }));
  }

  function networkObservationsFor(id) {
    return db.prepare("SELECT * FROM authoring_network_observations WHERE session_id=? ORDER BY observed_at").all(id);
  }

  function list() {
    // rowid DESC as a tiebreaker: two sessions started within the same
    // millisecond must still list most-recent-first, not in undefined order.
    return db.prepare("SELECT * FROM authoring_sessions ORDER BY started_at DESC, rowid DESC").all();
  }

  return { start, recordAction, recordNetworkObservation, complete, discard, fail, get, actionsFor, networkObservationsFor, list };
}
