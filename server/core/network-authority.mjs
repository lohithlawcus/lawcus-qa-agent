import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 10 / section 21 — Network Authority. Deliberately a separate
// approved record from an API contract: a contract describes what an
// endpoint *should do*; this describes what the Safe API Executor is
// *permitted to contact at all*. Both must independently resolve to an
// approved row before api-client.mjs will make a real call (section 22).

export class NetworkAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NON_HUMAN_ORIGINS = new Set(["ai_extraction", "ai_planner", "runner", "network_observer"]);

function requireHumanApprover(approver) {
  if (!approver || typeof approver !== "string")
    throw new NetworkAuthorityError("no_approver", "An approver identity is required.");
  if (NON_HUMAN_ORIGINS.has(approver))
    throw new NetworkAuthorityError(
      "non_human_approver",
      "Only a human operator can approve or reject Network Authority.",
    );
}

export function openNetworkAuthority(db, audit) {
  function proposeAuthority({ environmentId, allowedHosts, allowedMethods, allowRedirects = false }) {
    const latest = db
      .prepare("SELECT * FROM network_authorities WHERE environment_id=? ORDER BY version DESC LIMIT 1")
      .get(environmentId);
    const hostsJson = JSON.stringify([...allowedHosts].sort());
    const methodsJson = JSON.stringify([...allowedMethods].sort());
    if (
      latest &&
      latest.allowed_hosts === hostsJson &&
      latest.allowed_methods === methodsJson &&
      Boolean(latest.allow_redirects) === Boolean(allowRedirects)
    )
      return latest;
    const nextVersion = (latest?.version || 0) + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO network_authorities(
         id,environment_id,version,allowed_hosts,allowed_methods,allow_redirects,status,supersedes,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(id, environmentId, nextVersion, hostsJson, methodsJson, allowRedirects ? 1 : 0, "pending_review", latest?.id ?? null, now());
    audit?.("network_authority.proposed", id, { environmentId, version: nextVersion });
    return db.prepare("SELECT * FROM network_authorities WHERE id=?").get(id);
  }

  function decideAuthority(id, status, approver, note) {
    requireHumanApprover(approver);
    const at = now();
    const result = db
      .prepare(
        "UPDATE network_authorities SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending_review'",
      )
      .run(status, approver, at, note ?? null, id);
    if (!result.changes)
      throw new NetworkAuthorityError("not_pending", "This Network Authority is not pending review.");
    if (status === "approved") {
      const row = db.prepare("SELECT * FROM network_authorities WHERE id=?").get(id);
      db.prepare(
        `UPDATE network_authorities SET status='superseded',decided_at=?,decision_note=?
         WHERE environment_id=? AND status='approved' AND id<>?`,
      ).run(at, `Superseded by approved version ${row.version}.`, row.environment_id, id);
    }
    audit?.(`network_authority.${status}`, id, { approver });
    return db.prepare("SELECT * FROM network_authorities WHERE id=?").get(id);
  }

  const approveAuthority = (id, approver, note) => decideAuthority(id, "approved", approver, note);
  const rejectAuthority = (id, approver, note) => decideAuthority(id, "rejected", approver, note);

  /** Fails closed: no approved row means the executor has no authority to
   * contact anything for this environment, regardless of what any contract
   * or adapter says. */
  function resolveApprovedAuthority(environmentId) {
    const row = db
      .prepare("SELECT * FROM network_authorities WHERE environment_id=? AND status='approved'")
      .get(environmentId);
    if (!row)
      throw new NetworkAuthorityError(
        "no_approved_authority",
        `No approved Network Authority exists for "${environmentId}". Direct API execution is blocked.`,
      );
    return {
      ...row,
      allowedHosts: JSON.parse(row.allowed_hosts),
      allowedMethods: JSON.parse(row.allowed_methods),
      allowRedirects: Boolean(row.allow_redirects),
    };
  }

  function inbox() {
    return db.prepare("SELECT * FROM network_authorities WHERE status='pending_review' ORDER BY created_at").all();
  }

  function approved() {
    return db.prepare("SELECT * FROM network_authorities WHERE status='approved'").all();
  }

  return { proposeAuthority, approveAuthority, rejectAuthority, resolveApprovedAuthority, inbox, approved };
}
