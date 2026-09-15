import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 10 / section 20 — Environment Adapter. Keeps functional API
// contracts free of any host/origin string: a contract names an operation
// ("authenticate with email and password"), never a host. Exactly one place
// maps an environment to real origins.
//
// The authorized staging origins themselves are a single literal source of
// truth here — live-runner.mjs (the existing, already-tested browser-driven
// runner) imports STAGING/API_ORIGIN/ASSETS from this module instead of
// declaring its own copies, so nothing scatters these strings across the
// codebase (section 20). That relocation changes no behavior: same values,
// same file that used to own them, just re-exported from a single point.
//
// The DB-backed propose/approve/resolve pipeline below is the new part for
// Step 10: it governs the direct (non-browser) Safe API Executor, which has
// no existing hardcoded origin to lean on and must resolve a *currently
// approved* adapter at call time, exactly like every other trusted V5
// record (never auto-approved, never silently replaced).

export const STAGING = "https://lohith.fiveriverz.com";
export const API_ORIGIN = "https://api.fiveriverz.com";
export const ASSETS = "https://daewtpgqtk7am.cloudfront.net";

export class EnvironmentAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NON_HUMAN_ORIGINS = new Set(["ai_extraction", "ai_planner", "runner", "network_observer"]);

function requireHumanApprover(approver) {
  if (!approver || typeof approver !== "string")
    throw new EnvironmentAdapterError("no_approver", "An approver identity is required.");
  if (NON_HUMAN_ORIGINS.has(approver))
    throw new EnvironmentAdapterError(
      "non_human_approver",
      "Only a human operator can approve or reject an Environment Adapter.",
    );
}

export function openEnvironmentAdapter(db, audit) {
  function proposeAdapter({ environmentId, apiOrigin, appOrigin, assetsOrigin = null }) {
    const latest = db
      .prepare("SELECT * FROM environment_adapters WHERE environment_id=? ORDER BY version DESC LIMIT 1")
      .get(environmentId);
    if (
      latest &&
      latest.api_origin === apiOrigin &&
      latest.app_origin === appOrigin &&
      latest.assets_origin === assetsOrigin
    )
      return latest;
    const nextVersion = (latest?.version || 0) + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO environment_adapters(
         id,environment_id,version,api_origin,app_origin,assets_origin,status,supersedes,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(id, environmentId, nextVersion, apiOrigin, appOrigin, assetsOrigin, "pending_review", latest?.id ?? null, now());
    audit?.("environment_adapter.proposed", id, { environmentId, version: nextVersion });
    return db.prepare("SELECT * FROM environment_adapters WHERE id=?").get(id);
  }

  function decideAdapter(id, status, approver, note) {
    requireHumanApprover(approver);
    const at = now();
    const result = db
      .prepare(
        "UPDATE environment_adapters SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending_review'",
      )
      .run(status, approver, at, note ?? null, id);
    if (!result.changes)
      throw new EnvironmentAdapterError("not_pending", "This Environment Adapter is not pending review.");
    if (status === "approved") {
      const row = db.prepare("SELECT * FROM environment_adapters WHERE id=?").get(id);
      db.prepare(
        `UPDATE environment_adapters SET status='superseded',decided_at=?,decision_note=?
         WHERE environment_id=? AND status='approved' AND id<>?`,
      ).run(at, `Superseded by approved version ${row.version}.`, row.environment_id, id);
    }
    audit?.(`environment_adapter.${status}`, id, { approver });
    return db.prepare("SELECT * FROM environment_adapters WHERE id=?").get(id);
  }

  const approveAdapter = (id, approver, note) => decideAdapter(id, "approved", approver, note);
  const rejectAdapter = (id, approver, note) => decideAdapter(id, "rejected", approver, note);

  /** Fails closed: the Safe API Executor must never fall back to an
   * unapproved or missing adapter. */
  function resolveApprovedAdapter(environmentId) {
    const row = db
      .prepare("SELECT * FROM environment_adapters WHERE environment_id=? AND status='approved'")
      .get(environmentId);
    if (!row)
      throw new EnvironmentAdapterError(
        "no_approved_adapter",
        `No approved Environment Adapter exists for "${environmentId}". Direct API execution is blocked.`,
      );
    return row;
  }

  function inbox() {
    return db
      .prepare("SELECT * FROM environment_adapters WHERE status='pending_review' ORDER BY created_at")
      .all();
  }

  function approved() {
    return db.prepare("SELECT * FROM environment_adapters WHERE status='approved'").all();
  }

  return { proposeAdapter, approveAdapter, rejectAdapter, resolveApprovedAdapter, inbox, approved };
}
