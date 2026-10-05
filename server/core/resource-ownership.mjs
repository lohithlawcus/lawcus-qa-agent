import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 13 / section 25 — Test Data Ownership. Cleanup authority comes
// only from an exact server-assigned resource ID recorded here at
// creation time — never from a name prefix like "QA Agent - …" (section
// 25 says this explicitly: names aid debugging, they do not grant
// deletion authority). The UNIQUE(environment_id, resource_type,
// resource_id) constraint makes it structurally impossible for two rows
// to both claim ownership of the same real object.

export class ResourceOwnershipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CLEANUP_POLICIES = new Set(["auto", "manual", "retain"]);

// Deleting staging data is never something an automated actor may approve:
// the AI, the runner, the network observer and the MCP server can all
// propose, but only a named human operator can approve a deletion.
const NON_HUMAN_DELETION_APPROVERS = new Set(["ai_extraction", "ai_planner", "runner", "network_observer", "mcp"]);

function requireHumanApproverForDeletion(approver) {
  if (!approver || typeof approver !== "string")
    throw new ResourceOwnershipError("no_approver", "A deletion needs a named approver.");
  if (NON_HUMAN_DELETION_APPROVERS.has(approver) || !approver.startsWith("operator:"))
    throw new ResourceOwnershipError("non_human_approver", "Only a named human operator can approve a staging deletion.");
}

/**
 * Orders a set of ownership rows so a child is always cleaned before its
 * parent (section 28: "reverse dependency order") — Kahn's algorithm run
 * against the reversed parent-points-up edges: a row becomes eligible once
 * every row that names it as a parent has already been placed. Rows
 * outside the given set (already cleaned, or belonging to another run)
 * don't block anything — only in-set children count.
 */
export function reverseDependencyOrder(rows) {
  const ids = new Set(rows.map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const remainingChildren = new Map(rows.map((r) => [r.id, 0]));
  for (const r of rows)
    if (r.parent_resource_id && ids.has(r.parent_resource_id))
      remainingChildren.set(r.parent_resource_id, remainingChildren.get(r.parent_resource_id) + 1);
  const queue = rows.filter((r) => remainingChildren.get(r.id) === 0);
  const order = [];
  const placed = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (placed.has(node.id)) continue;
    placed.add(node.id);
    order.push(node);
    const parentId = node.parent_resource_id;
    if (parentId && ids.has(parentId)) {
      const remaining = remainingChildren.get(parentId) - 1;
      remainingChildren.set(parentId, remaining);
      if (remaining === 0) queue.push(byId.get(parentId));
    }
  }
  // A cycle should be structurally impossible (parent_resource_id always
  // points at a row created earlier), but never silently drop a resource
  // from cleanup if one somehow occurred.
  for (const r of rows) if (!placed.has(r.id)) order.push(r);
  return order;
}

// A leftover is a record this run created that is still sitting in staging:
// waiting on a person (cleanup_policy 'manual'), or a cleanup that was
// skipped or failed. 'retain' means someone decided to keep it on purpose,
// so it is not a leftover; 'cleaned' and 'already_missing' are done.
const LEFTOVER_SQL = "cleanup_policy <> 'retain' AND cleanup_status IN ('pending','failed','skipped')";

/**
 * protectedResourceIds: exact IDs (the QA-owned fixture records other
 * checks depend on) that can never be recorded as owned — so no cleanup
 * handler, now or later, can ever be pointed at one, whatever a check
 * reports.
 */
export function openResourceOwnership(db, audit, { protectedResourceIds = [] } = {}) {
  const protectedIds = new Set(protectedResourceIds);

  function recordCreated({
    runId,
    environmentId,
    resourceType,
    resourceId,
    parentResourceId = null,
    createdByPrimitive,
    displayName = null,
    cleanupPolicy = "auto",
  }) {
    if (!CLEANUP_POLICIES.has(cleanupPolicy))
      throw new ResourceOwnershipError("unknown_cleanup_policy", `Unknown cleanup policy: ${cleanupPolicy}`);
    if (protectedIds.has(resourceId))
      throw new ResourceOwnershipError("protected_resource", `Resource "${resourceId}" is a protected QA fixture and can never be recorded as created (or cleaned up) by a run.`);
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO resource_ownership(
           id,run_id,environment_id,resource_type,resource_id,parent_resource_id,
           created_by_primitive,display_name,cleanup_policy,cleanup_status,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        runId,
        environmentId,
        resourceType,
        resourceId,
        parentResourceId,
        createdByPrimitive,
        displayName,
        cleanupPolicy,
        "pending",
        now(),
      );
    } catch (error) {
      // Only a UNIQUE violation means "already owned"; anything else (a
      // missing run, a bad environment) is a different problem and must
      // not be mislabeled.
      if (!/UNIQUE constraint/i.test(String(error?.message))) throw error;
      throw new ResourceOwnershipError(
        "already_owned",
        `A resource of type "${resourceType}" with id "${resourceId}" is already owned by another run.`,
      );
    }
    audit?.("resource.owned", id, { runId, resourceType, resourceId, cleanupPolicy });
    return db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
  }

  function markCleanup(id, { status, note = null }) {
    db.prepare("UPDATE resource_ownership SET cleanup_status=?,cleanup_note=?,cleaned_at=? WHERE id=?").run(
      status,
      note,
      now(),
      id,
    );
    audit?.("resource.cleanup_recorded", id, { status });
  }

  function forRun(runId) {
    return db.prepare("SELECT * FROM resource_ownership WHERE run_id=? ORDER BY created_at").all(runId);
  }

  /** Only what this run created, only cleanup_policy='auto', only rows
   * still cleanup_status='pending' — 'manual' and 'retain' resources are
   * never touched here (section 25/28: exact IDs the run actually owns,
   * nothing broader). */
  function pendingCleanupForRun(runId) {
    const rows = db
      .prepare(
        "SELECT * FROM resource_ownership WHERE run_id=? AND cleanup_policy='auto' AND cleanup_status='pending'",
      )
      .all(runId);
    return reverseDependencyOrder(rows);
  }

  function leftoversForRun(runId) {
    return db.prepare(`SELECT * FROM resource_ownership WHERE run_id=? AND ${LEFTOVER_SQL} ORDER BY created_at`).all(runId);
  }

  function allLeftovers(limit = 200) {
    return db.prepare(`SELECT * FROM resource_ownership WHERE ${LEFTOVER_SQL} ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  /** A person deals with a leftover. 'removed' = they deleted it in Lawcus
   * themselves; 'keep' = they decided to leave it. Nothing here touches
   * staging — it only records the human decision. */
  function resolveLeftover(id, { action, actor, note = null }) {
    if (!["removed", "keep"].includes(action)) throw new ResourceOwnershipError("invalid_action", `Unknown action: ${action}`);
    const row = db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
    if (!row) throw new ResourceOwnershipError("not_found", "No such owned record.");
    if (!db.prepare(`SELECT 1 FROM resource_ownership WHERE id=? AND ${LEFTOVER_SQL}`).get(id))
      throw new ResourceOwnershipError("not_leftover", "This record is not waiting on anyone.");
    const detail = note ? `: ${String(note).slice(0, 300)}` : "";
    if (action === "removed") {
      db.prepare("UPDATE resource_ownership SET cleanup_status='cleaned',cleanup_note=?,cleaned_at=? WHERE id=?").run(`Removed manually by ${actor}${detail}`, now(), id);
    } else {
      db.prepare("UPDATE resource_ownership SET cleanup_policy='retain',cleanup_note=? WHERE id=?").run(`Kept on purpose by ${actor}${detail}`, id);
    }
    audit?.("resource.leftover_resolved", id, { action, actor });
    return db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
  }

  /** A record may be deleted from staging only after a person approves it,
   * one record at a time. Only records the tool itself recorded at creation
   * (by exact ID) can be approved — never a name match, and never a
   * protected fixture (which cannot be recorded at all). Approval only flips
   * the record to cleanup_policy 'auto'; nothing is deleted here. The actual
   * delete runs later in runApprovedDeletions (cleanup.mjs), which skips any
   * record whose type has no delete handler and leaves it approved, so an
   * approval is never silently consumed. */
  function approveDeletion(id, { approver }) {
    requireHumanApproverForDeletion(approver);
    const row = db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
    if (!row) throw new ResourceOwnershipError("not_found", "No such owned record.");
    if (row.cleanup_status !== "pending")
      throw new ResourceOwnershipError("not_pending", `This record is already ${row.cleanup_status}; only a pending record can be approved for deletion.`);
    if (row.cleanup_policy === "retain")
      throw new ResourceOwnershipError("kept_on_purpose", "This record was kept on purpose. Revoke that decision before approving it for deletion.");
    if (protectedIds.has(row.resource_id))
      throw new ResourceOwnershipError("protected_resource", "A protected QA fixture can never be approved for deletion.");
    db.prepare("UPDATE resource_ownership SET cleanup_policy='auto',cleanup_note=? WHERE id=?").run(
      `Approved for deletion by ${approver} on ${now()}`,
      id,
    );
    audit?.("resource.deletion_approved", id, { approver, resourceType: row.resource_type });
    return db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
  }

  /** Withdraws an approval that has not been carried out yet. */
  function revokeDeletion(id, { approver }) {
    requireHumanApproverForDeletion(approver);
    const row = db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
    if (!row) throw new ResourceOwnershipError("not_found", "No such owned record.");
    if (row.cleanup_status !== "pending" || row.cleanup_policy !== "auto")
      throw new ResourceOwnershipError("not_approved", "Only a pending, approved record can have its approval withdrawn.");
    db.prepare("UPDATE resource_ownership SET cleanup_policy='manual',cleanup_note=? WHERE id=?").run(
      `Approval withdrawn by ${approver} on ${now()}`,
      id,
    );
    audit?.("resource.deletion_revoked", id, { approver });
    return db.prepare("SELECT * FROM resource_ownership WHERE id=?").get(id);
  }

  /** Approved records still waiting for their delete, in dependency order. */
  function approvedForDeletion(environmentId = null) {
    const rows = db
      .prepare(
        "SELECT * FROM resource_ownership WHERE cleanup_policy='auto' AND cleanup_status='pending' AND (? IS NULL OR environment_id=?) ORDER BY created_at",
      )
      .all(environmentId, environmentId);
    return reverseDependencyOrder(rows);
  }

  return {
    recordCreated,
    markCleanup,
    forRun,
    pendingCleanupForRun,
    leftoversForRun,
    allLeftovers,
    resolveLeftover,
    approveDeletion,
    revokeDeletion,
    approvedForDeletion,
  };
}
