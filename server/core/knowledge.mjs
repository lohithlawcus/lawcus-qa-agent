import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 9 / sections 8 & 9 — Lawcus Knowledge Base + Behavior/Impact
// Graph. Mirrors the proposals.mjs approval discipline (section 14): a
// human approves or rejects; nothing in here ever marks its own item
// approved, no matter how strong its provenance.

export class KnowledgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NON_HUMAN_ORIGINS = new Set(["ai_extraction", "ai_planner", "runner", "network_observer"]);

function requireHumanApprover(approver) {
  if (!approver || typeof approver !== "string")
    throw new KnowledgeError("no_approver", "An approver identity is required.");
  if (NON_HUMAN_ORIGINS.has(approver))
    throw new KnowledgeError(
      "non_human_approver",
      "AI extraction can propose Knowledge; only a human operator can approve or reject it.",
    );
}

export function openKnowledge(db, audit) {
  function ensureFeature(name, description) {
    let feature = db.prepare("SELECT * FROM features WHERE name=?").get(name);
    if (!feature) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO features(id,name,description,created_at) VALUES(?,?,?,?)",
      ).run(id, name, description, now());
      feature = { id, name, description };
      audit?.("knowledge.feature.created", id, { name });
    }
    return feature;
  }

  function ensureSource({ title, url, author }) {
    // Sources are keyed by URL when present (re-ingesting the same article
    // must not create a duplicate source row); a project-internal source
    // (no URL, e.g. "verified in this project's own implementation") is
    // always a fresh row since there's nothing stable to dedupe on.
    if (url) {
      const existing = db.prepare("SELECT * FROM knowledge_sources WHERE url=?").get(url);
      if (existing) return existing;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO knowledge_sources(id,title,url,author,ingested_at) VALUES(?,?,?,?,?)",
    ).run(id, title, url ?? null, author ?? null, now());
    audit?.("knowledge.source.ingested", id, { title, url });
    return { id, title, url, author };
  }

  /**
   * Proposes one atomic Knowledge item (section 8.1). Idempotent by
   * semantic_id + statement: proposing the exact same statement again does
   * nothing; a changed statement for a known semantic_id appends a new
   * version referencing the one it supersedes (section 8.3) — existing
   * versions are never rewritten. Always enters as pending_review,
   * regardless of provenance quality; PRODUCT_APPROVED describes where the
   * fact came from, not that it skips review.
   */
  function proposeItem({
    semanticId,
    type,
    featureName,
    featureDescription,
    title,
    statement,
    doesNotMean = null,
    provenance,
    source = null,
  }) {
    const feature = ensureFeature(featureName, featureDescription);
    const sourceRow = source ? ensureSource(source) : null;
    const latest = db
      .prepare(
        "SELECT * FROM knowledge_items WHERE semantic_id=? ORDER BY version DESC LIMIT 1",
      )
      .get(semanticId);
    if (latest && latest.statement === statement) return latest;
    const nextVersion = (latest?.version || 0) + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO knowledge_items(
         id,semantic_id,version,type,feature_id,title,statement,does_not_mean,
         provenance,source_id,status,supersedes,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      semanticId,
      nextVersion,
      type,
      feature.id,
      title,
      statement,
      doesNotMean,
      provenance,
      sourceRow?.id ?? null,
      "pending_review",
      latest?.id ?? null,
      now(),
    );
    audit?.("knowledge.item.proposed", id, { semanticId, version: nextVersion, provenance });
    return db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(id);
  }

  function decideItem(id, status, approver, note) {
    requireHumanApprover(approver);
    const at = now();
    const result = db
      .prepare(
        "UPDATE knowledge_items SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending_review'",
      )
      .run(status, approver, at, note ?? null, id);
    if (!result.changes)
      throw new KnowledgeError("not_pending", "This Knowledge item is not pending review.");
    if (status === "approved") {
      // Approving a new version supersedes any earlier approved version of
      // the same semantic_id — there is only ever one currently-trusted
      // version, matching test_definition_versions' current_version pattern.
      const item = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(id);
      db.prepare(
        `UPDATE knowledge_items SET status='superseded',decided_at=?,decision_note=?
         WHERE semantic_id=? AND status='approved' AND id<>?`,
      ).run(at, `Superseded by approved version ${item.version}.`, item.semantic_id, id);
    }
    audit?.(`knowledge.item.${status}`, id, { approver });
    return db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(id);
  }

  const approveItem = (id, approver, note) => decideItem(id, "approved", approver, note);
  const rejectItem = (id, approver, note) => decideItem(id, "rejected", approver, note);

  /**
   * Proposes one typed edge between two features (section 9). Idempotent
   * on (type, from, to) — the UNIQUE constraint means re-proposing an
   * identical edge (even with a different rationale) is a no-op; a
   * genuinely different relationship needs a different type.
   */
  function proposeEdge({ type, fromFeatureName, toFeatureName, rationale, source = null }) {
    const from = db.prepare("SELECT * FROM features WHERE name=?").get(fromFeatureName);
    const to = db.prepare("SELECT * FROM features WHERE name=?").get(toFeatureName);
    if (!from || !to)
      throw new KnowledgeError(
        "unknown_feature",
        `Both features must already exist: "${fromFeatureName}" -> "${toFeatureName}".`,
      );
    const existing = db
      .prepare("SELECT * FROM behavior_graph_edges WHERE type=? AND from_feature_id=? AND to_feature_id=?")
      .get(type, from.id, to.id);
    if (existing) return existing;
    const sourceRow = source ? ensureSource(source) : null;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO behavior_graph_edges(id,type,from_feature_id,to_feature_id,rationale,source_id,status,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(id, type, from.id, to.id, rationale, sourceRow?.id ?? null, "pending_review", now());
    audit?.("knowledge.edge.proposed", id, { type, from: fromFeatureName, to: toFeatureName });
    return db.prepare("SELECT * FROM behavior_graph_edges WHERE id=?").get(id);
  }

  function decideEdge(id, status, approver, note) {
    requireHumanApprover(approver);
    const result = db
      .prepare(
        "UPDATE behavior_graph_edges SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending_review'",
      )
      .run(status, approver, now(), note ?? null, id);
    if (!result.changes)
      throw new KnowledgeError("not_pending", "This edge is not pending review.");
    audit?.(`knowledge.edge.${status}`, id, { approver });
    return db.prepare("SELECT * FROM behavior_graph_edges WHERE id=?").get(id);
  }

  const approveEdge = (id, approver, note) => decideEdge(id, "approved", approver, note);
  const rejectEdge = (id, approver, note) => decideEdge(id, "rejected", approver, note);

  /** Only approved edges — section 9: "Unapproved proposed edges do not
   * alter trusted impact calculations." Use this for any real impact
   * analysis; use inbox()-style queries when showing pending edges for
   * review. */
  function approvedGraph() {
    return db
      .prepare(
        `SELECT behavior_graph_edges.*, ff.name AS from_feature, tf.name AS to_feature
         FROM behavior_graph_edges
         JOIN features ff ON ff.id = behavior_graph_edges.from_feature_id
         JOIN features tf ON tf.id = behavior_graph_edges.to_feature_id
         WHERE behavior_graph_edges.status='approved'`,
      )
      .all();
  }

  function inboxItems() {
    return db
      .prepare(
        `SELECT knowledge_items.*, features.name AS feature_name
         FROM knowledge_items JOIN features ON features.id = knowledge_items.feature_id
         WHERE knowledge_items.status='pending_review' ORDER BY knowledge_items.created_at`,
      )
      .all();
  }

  function inboxEdges() {
    return db
      .prepare(
        `SELECT behavior_graph_edges.*, ff.name AS from_feature, tf.name AS to_feature
         FROM behavior_graph_edges
         JOIN features ff ON ff.id = behavior_graph_edges.from_feature_id
         JOIN features tf ON tf.id = behavior_graph_edges.to_feature_id
         WHERE behavior_graph_edges.status='pending_review' ORDER BY behavior_graph_edges.created_at`,
      )
      .all();
  }

  /** Approved Knowledge, grouped by feature — the trusted, current-version
   * view (one row per semantic_id, its latest approved version only). */
  function approvedByFeature() {
    const rows = db
      .prepare(
        `SELECT knowledge_items.*, features.name AS feature_name
         FROM knowledge_items JOIN features ON features.id = knowledge_items.feature_id
         WHERE knowledge_items.status='approved' ORDER BY features.name, knowledge_items.type, knowledge_items.title`,
      )
      .all();
    const byFeature = new Map();
    for (const row of rows) {
      if (!byFeature.has(row.feature_name)) byFeature.set(row.feature_name, []);
      byFeature.get(row.feature_name).push(row);
    }
    return [...byFeature.entries()].map(([feature, items]) => ({ feature, items }));
  }

  return {
    ensureFeature,
    proposeItem,
    approveItem,
    rejectItem,
    proposeEdge,
    approveEdge,
    rejectEdge,
    approvedGraph,
    inboxItems,
    inboxEdges,
    approvedByFeature,
  };
}
