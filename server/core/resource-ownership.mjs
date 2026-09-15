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

export function openResourceOwnership(db, audit) {
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
    } catch {
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

  return { recordCreated, markCleanup, forRun, pendingCleanupForRun };
}
