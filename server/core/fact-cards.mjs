// KB-03: the reviewer's view of a fact. Everything a person needs to decide
// whether to trust a rule, in one place: what it says, who approved it and when,
// where it applies, what evidence supports it, which tests assert it, and
// whether it has been superseded, is waiting for review, or has gone stale.
// Read-only: nothing here changes a fact.

import { AUTHORITY_RANK, isExpectation } from "./knowledge.mjs";

const UUID = /^[a-f0-9-]{36}$/;
const RETIRED_DUPLICATE_NOTE = /^Duplicate of /;
const now = () => Date.now();

const parseJson = (value) => (typeof value === "string" ? JSON.parse(value) : (value ?? null));

export function openFactCards(db, { knowledge, testbook }) {
  const casesByExternalId = () => {
    const map = new Map();
    for (const feature of testbook.tree()) for (const suite of feature.suites) for (const testCase of suite.cases) map.set(testCase.externalId, testCase);
    return map;
  };

  /** The row a reference points at: an item id, a semantic id, or an alias. A
   * semantic id resolves to its current (approved) version if it has one,
   * otherwise its latest. */
  function resolve(ref) {
    if (typeof ref !== "string" || !ref) return null;
    if (UUID.test(ref)) return db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(ref) ?? null;
    const target = knowledge.resolveSemanticId(ref);
    if (!target) return null;
    return (
      db.prepare("SELECT * FROM knowledge_items WHERE semantic_id=? AND status='approved'").get(target.semantic_id) ??
      db.prepare("SELECT * FROM knowledge_items WHERE semantic_id=? ORDER BY version DESC LIMIT 1").get(target.semantic_id)
    );
  }

  function derivedStatus(row, openFlagCount) {
    if (row.status === "approved") {
      if (row.effective_until && Date.parse(row.effective_until) < now()) return "stale";
      return openFlagCount ? "under_review" : "current";
    }
    if (row.status === "rejected") return RETIRED_DUPLICATE_NOTE.test(row.decision_note ?? "") ? "retired_duplicate" : "rejected";
    if (row.status === "pending_review") return "pending";
    return row.status; // superseded, deprecated
  }

  function factCard(ref) {
    const row = resolve(ref);
    if (!row) return null;
    const versions = db.prepare("SELECT * FROM knowledge_items WHERE semantic_id=? ORDER BY version").all(row.semantic_id);
    const ids = versions.map((v) => v.id);
    const openFlags = knowledge.openReviewFlags(ids);
    const links = knowledge.itemLinks(row.id);
    const cases = casesByExternalId();
    const source = row.source_id ? db.prepare("SELECT * FROM knowledge_sources WHERE id=?").get(row.source_id) : null;
    const aliases = db
      .prepare(`SELECT alias_semantic_id, reason, created_at FROM knowledge_item_aliases WHERE knowledge_item_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...ids);
    const feature = db.prepare("SELECT name FROM features WHERE id=?").get(row.feature_id)?.name ?? null;
    const approvedLater = versions.find((v) => v.version > row.version && v.status === "approved") ?? null;
    const scope = parseJson(row.scope);

    return {
      id: row.id,
      semanticId: row.semantic_id,
      version: row.version,
      feature,
      type: row.type,
      title: row.title,
      statement: row.statement,
      doesNotMean: row.does_not_mean,
      status: row.status,
      derivedStatus: derivedStatus(row, openFlags.length),
      // OBSERVED (seen on a tenant) is not EXPECTED (a rule someone owns).
      authority: {
        provenance: row.provenance,
        rank: AUTHORITY_RANK[row.provenance] ?? 0,
        kind: isExpectation(row.provenance) ? "expected" : "observed_or_inferred",
      },
      source: source ? { title: source.title, url: source.url, author: source.author, ingestedAt: source.ingested_at } : null,
      evidenceGap: source === null,
      approval: row.status === "approved" || row.decided_by ? { by: row.decided_by, at: row.decided_at, note: row.decision_note } : null,
      appliesWhere: {
        scope,
        unscoped: scope === null,
        recordKinds: parseJson(row.applies_to),
        preconditions: parseJson(row.preconditions),
        expectedBehavior: parseJson(row.expected_behavior),
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
        release: row.release,
      },
      assertedByTests: links.relatedTests.map((externalId) => {
        const testCase = cases.get(externalId);
        return testCase
          ? { externalId, title: testCase.title, runnable: Boolean(testCase.runnable), status: testCase.status, quarantineReason: testCase.quarantineReason ?? null }
          : { externalId, missing: true };
      }),
      apiContracts: links.apiContracts,
      supersession: {
        supersededBy: approvedLater ? { id: approvedLater.id, version: approvedLater.version } : null,
        supersedes: row.supersedes,
      },
      history: versions.map((v) => ({
        id: v.id, version: v.version, status: v.status, provenance: v.provenance, statement: v.statement,
        decidedBy: v.decided_by, decidedAt: v.decided_at, decisionNote: v.decision_note, createdAt: v.created_at, supersedes: v.supersedes,
      })),
      pendingRevisions: versions.filter((v) => v.status === "pending_review" && v.id !== row.id).map((v) => ({ id: v.id, version: v.version, statement: v.statement })),
      openReviewFlags: openFlags.map((flag) => ({ id: flag.flag_id, note: flag.note, raisedAt: flag.raised_at, signal: flag.signal_title })),
      aliases: aliases.map((a) => ({ semanticId: a.alias_semantic_id, reason: a.reason, since: a.created_at })),
    };
  }

  /** One compact row per fact (its current version), for the review list. */
  function listFacts({ status = null, feature = null } = {}) {
    const rows = db.prepare("SELECT * FROM knowledge_items ORDER BY semantic_id, version").all();
    const bySemantic = new Map();
    for (const row of rows) {
      const held = bySemantic.get(row.semantic_id);
      // prefer the approved version; otherwise the latest
      if (!held || row.status === "approved" || (held.status !== "approved" && row.version > held.version)) bySemantic.set(row.semantic_id, row);
    }
    // A flag on ANY version of a fact keeps the fact under review (as its card shows),
    // even after a newer version has been approved, until a person resolves the flag.
    const flagged = new Set(
      db.prepare(
        `SELECT DISTINCT knowledge_items.semantic_id FROM knowledge_review_flags
         JOIN knowledge_items ON knowledge_items.id = knowledge_review_flags.knowledge_item_id
         WHERE knowledge_review_flags.status='open'`,
      ).all().map((row) => row.semantic_id),
    );
    const featureNames = new Map(db.prepare("SELECT id, name FROM features").all().map((f) => [f.id, f.name]));
    const testCounts = new Map(db.prepare("SELECT knowledge_item_id, COUNT(*) n FROM knowledge_item_tests GROUP BY knowledge_item_id").all().map((r) => [r.knowledge_item_id, r.n]));
    return [...bySemantic.values()]
      .map((row) => ({
        semanticId: row.semantic_id,
        id: row.id,
        title: row.title,
        feature: featureNames.get(row.feature_id) ?? null,
        type: row.type,
        derivedStatus: derivedStatus(row, flagged.has(row.semantic_id) ? 1 : 0),
        provenance: row.provenance,
        authorityKind: isExpectation(row.provenance) ? "expected" : "observed_or_inferred",
        hasSource: row.source_id !== null,
        scoped: row.scope !== null,
        testCount: testCounts.get(row.id) ?? 0,
        decidedBy: row.decided_by,
        decidedAt: row.decided_at,
      }))
      .filter((fact) => (!status || fact.derivedStatus === status) && (!feature || fact.feature === feature));
  }

  /** Facts (approved or awaiting review) with nothing to point at. */
  function unsourcedFacts() {
    return db
      .prepare(
        `SELECT knowledge_items.id, semantic_id, title, status, provenance, features.name AS feature
         FROM knowledge_items JOIN features ON features.id = knowledge_items.feature_id
         WHERE source_id IS NULL AND status IN ('approved','pending_review') ORDER BY status, semantic_id`,
      )
      .all()
      .map((row) => ({ id: row.id, semanticId: row.semantic_id, title: row.title, status: row.status, provenance: row.provenance, feature: row.feature }));
  }

  return { factCard, listFacts, unsourcedFacts, derivedStatus };
}
