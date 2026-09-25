// KB-05: the product-change loop. A person hands the agent a change signal
// (a QA note, a requirement, a release note, an observed difference...). The
// agent records it with its source and time, works out — deterministically,
// with no model call — which approved facts and which tests it may touch, and
// lets a human turn that into PENDING revisions and review flags.
//
// What this module never does: change an approved fact, change a test, or
// change any pass/fail expectation. Revisions go through proposeItem (pending
// review, human approval, exactly like every other Knowledge change); flags
// and resolutions need a human identity and are informational.

import { createHash, randomUUID } from "node:crypto";
import { KnowledgeError, PROVENANCE_VALUES, requireHumanApprover } from "./knowledge.mjs";
import { traverseImpactGraph } from "./impacted-testing.mjs";
import { redactText, containsSecret } from "./redact.mjs";

export const SIGNAL_KINDS = ["qa_note", "requirement", "design", "api_spec", "release_note", "code_change", "observed_diff"];
const MAX_TITLE = 200;
const MAX_BODY = 20000;
const MAX_REF = 500;
const RESOLUTIONS = ["still_valid", "revised", "obsolete"];

const STOPWORDS = new Set(
  "that this with from have has had will would should could when then than them they their there these those what which while where into onto also only more most much some such each other over under after before about between because being both does done for and are was were not but can may must its the you your our out any all new now use used using".split(" "),
);

const now = () => new Date().toISOString();
const normalize = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();
const terms = (text) => new Set((String(text).toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((word) => !STOPWORDS.has(word)));
const SEMANTIC_ID = /\b(?:[A-Z]+)(?:-[A-Z0-9]+)+(?:-\d{3})?\b/g;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fail(code, message) {
  throw new KnowledgeError(code, message);
}

export function openChangeSignals(db, audit, { knowledge, testbook }) {
  const getRow = (id) => db.prepare("SELECT * FROM change_signals WHERE id=?").get(id);
  const present = (row) => (row ? { ...row, analysis: row.analysis ? JSON.parse(row.analysis) : null } : null);
  const requireSignal = (id) => {
    const row = getRow(id);
    if (!row) fail("not_found", "That change signal could not be found.");
    return row;
  };

  /** Records a signal. The same text is never recorded twice: a repeat (under
   * any kind, source or title casing) returns the existing signal. */
  function submit({ kind, title, body, source = null, sourceRef = null, occurredAt = null, submittedBy }) {
    if (!SIGNAL_KINDS.includes(kind)) fail("invalid_kind", `Kind must be one of: ${SIGNAL_KINDS.join(", ")}.`);
    if (typeof submittedBy !== "string" || !submittedBy) fail("no_submitter", "Who is submitting this signal must be recorded.");
    for (const [label, value] of [["title", title], ["body", body]]) {
      if (typeof value !== "string" || !value.trim()) fail("invalid_signal", `A change signal needs a ${label}.`);
    }
    if (title.length > MAX_TITLE) fail("invalid_signal", `The title is longer than ${MAX_TITLE} characters.`);
    if (body.length > MAX_BODY) fail("invalid_signal", `The body is longer than ${MAX_BODY} characters.`);
    if (sourceRef && sourceRef.length > MAX_REF) fail("invalid_signal", `The source reference is longer than ${MAX_REF} characters.`);
    let occurred = now();
    if (occurredAt) {
      const parsed = new Date(occurredAt);
      if (Number.isNaN(parsed.getTime())) fail("invalid_signal", "occurredAt is not a valid date.");
      occurred = parsed.toISOString();
    }
    // Credentials pasted into a note are masked before they are stored.
    const cleanTitle = redactText(title.trim());
    const cleanBody = redactText(body.trim());
    const hash = createHash("sha256").update(`${normalize(cleanTitle)}\n${normalize(cleanBody)}`).digest("hex");
    const existing = db.prepare("SELECT * FROM change_signals WHERE content_hash=?").get(hash);
    if (existing) {
      audit?.("change_signal.duplicate_suppressed", existing.id, { submittedBy });
      return { ...present(existing), duplicate: true };
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO change_signals(id,kind,title,body,source,source_ref,occurred_at,received_at,submitted_by,content_hash,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,'new')`,
    ).run(id, kind, cleanTitle, cleanBody, source ? redactText(source) : null, sourceRef ? redactText(sourceRef) : null, occurred, now(), submittedBy, hash);
    audit?.("change_signal.submitted", id, { kind, submittedBy });
    return { ...present(getRow(id)), duplicate: false };
  }

  /**
   * Which approved facts might this signal touch, and which tests should be
   * re-run because of it. Deterministic and explainable: every entry carries
   * the reason it is there and how strong that reason is.
   */
  function computeAnalysis(signal) {
    const text = `${signal.title}\n${signal.body}`;
    const textTerms = terms(text);
    const approvedGroups = knowledge.approvedByFeature();
    const tree = testbook.tree();
    const casesByFeature = new Map(tree.map((feature) => [feature.name, feature.suites.flatMap((suite) => suite.cases)]));

    const namedFeatures = new Set();
    for (const feature of tree) {
      if (new RegExp(`\\b${escapeRegExp(feature.name)}\\b`, "i").test(text)) namedFeatures.add(feature.name);
    }
    const citedIds = new Set();
    for (const match of text.match(SEMANTIC_ID) || []) {
      const resolved = knowledge.resolveSemanticId(match);
      if (resolved) citedIds.add(resolved.semantic_id);
    }

    const affectedFacts = new Map();
    const consider = (item, feature, basis, strength, extra = {}) => {
      const prior = affectedFacts.get(item.id);
      if (prior && prior.strength >= strength) return;
      affectedFacts.set(item.id, { itemId: item.id, semanticId: item.semantic_id, feature, title: item.title, statement: item.statement, basis, strength, ...extra });
    };
    for (const group of approvedGroups) {
      for (const item of group.items) {
        if (citedIds.has(item.semantic_id)) {
          consider(item, group.feature, "cited", 3, { because: `The signal names ${item.semantic_id}.` });
        } else if (namedFeatures.has(group.feature)) {
          consider(item, group.feature, "feature_named", 2, { because: `The signal names the feature "${group.feature}".` });
        } else {
          const shared = [...terms(`${item.title} ${item.statement}`)].filter((word) => textTerms.has(word));
          if (shared.length >= 3) consider(item, group.feature, "term_overlap", 1, { matchedTerms: shared.slice(0, 8), because: `Shares ${shared.length} distinctive terms with the signal.` });
        }
      }
    }
    const facts = [...affectedFacts.values()].sort((a, b) => b.strength - a.strength || a.semanticId.localeCompare(b.semanticId));

    // Regression candidates, strongest reason first.
    const candidates = new Map();
    const addCase = (testCase, feature, basis, strength, because) => {
      const prior = candidates.get(testCase.externalId);
      const reason = { basis, because };
      if (prior) {
        prior.reasons.push(reason);
        prior.strength = Math.max(prior.strength, strength);
        return;
      }
      let blockedReason = null;
      if (testCase.status !== "approved") blockedReason = "not_approved";
      else if (!testCase.runnable) blockedReason = "quarantined";
      candidates.set(testCase.externalId, {
        externalId: testCase.externalId, title: testCase.title, feature, risk: testCase.risk,
        runnable: Boolean(testCase.runnable), blockedReason, quarantineReason: testCase.quarantineReason ?? null,
        strength, reasons: [reason],
      });
    };
    const allCases = new Map();
    for (const [feature, cases] of casesByFeature) for (const testCase of cases) allCases.set(testCase.externalId, { testCase, feature });

    const factFeatures = new Map();
    for (const fact of facts) {
      const item = approvedGroups.flatMap((group) => group.items).find((candidate) => candidate.id === fact.itemId);
      for (const externalId of item?.related_tests || []) {
        const entry = allCases.get(externalId);
        if (entry) addCase(entry.testCase, entry.feature, "linked_to_fact", 3, `Linked to ${fact.semanticId}, which this signal may change.`);
      }
      factFeatures.set(fact.feature, Math.max(factFeatures.get(fact.feature) || 0, fact.strength));
    }
    for (const name of namedFeatures) factFeatures.set(name, Math.max(factFeatures.get(name) || 0, 2));
    for (const [feature, strength] of factFeatures) {
      for (const testCase of casesByFeature.get(feature) || []) {
        addCase(testCase, feature, strength >= 2 ? "same_feature" : "same_feature_weak", strength >= 2 ? 2 : 1,
          strength >= 2 ? `Covers "${feature}", which the signal concerns.` : `Covers "${feature}", which only loosely matches the signal.`);
      }
    }
    const edges = knowledge.approvedGraph();
    for (const [feature] of factFeatures) {
      for (const neighbor of traverseImpactGraph(edges, feature).filter((name) => name !== feature)) {
        for (const testCase of casesByFeature.get(neighbor) || []) {
          addCase(testCase, neighbor, "graph_neighbor", 1, `"${neighbor}" is connected to "${feature}" by an approved dependency.`);
        }
      }
    }
    const ordered = [...candidates.values()].sort((a, b) => b.strength - a.strength || a.externalId.localeCompare(b.externalId));

    const missingInformation = [];
    if (!facts.length && !namedFeatures.size) {
      missingInformation.push("No known feature or approved fact matched this signal. Say which feature it concerns, or it cannot be tied to any test.");
    }
    // A fact the signal names outright is reported on its own; facts that are
    // only in scope because their feature was named are summarised per feature.
    const unlinked = (fact) => !(approvedGroups.flatMap((group) => group.items).find((candidate) => candidate.id === fact.itemId)?.related_tests || []).length;
    for (const fact of facts.filter((entry) => entry.strength === 3 && unlinked(entry))) {
      missingInformation.push(`${fact.semanticId} has no test case linked to it, so nothing proves it after this change.`);
    }
    const broad = new Map();
    for (const fact of facts.filter((entry) => entry.strength === 2 && unlinked(entry))) broad.set(fact.feature, (broad.get(fact.feature) || 0) + 1);
    for (const [feature, count] of broad) missingInformation.push(`${count} approved fact${count === 1 ? "" : "s"} in "${feature}" ${count === 1 ? "has" : "have"} no linked test case.`);
    for (const feature of factFeatures.keys()) {
      if (!(casesByFeature.get(feature) || []).length) missingInformation.push(`"${feature}" has no test cases at all.`);
    }

    return {
      affectedFacts: facts,
      namedFeatures: [...namedFeatures],
      regressionPlan: {
        run: ordered.filter((entry) => entry.runnable),
        blocked: ordered.filter((entry) => !entry.runnable),
      },
      missingInformation,
      note: "Nothing here changes an approved fact, a test, or an expected result. Revisions are proposed for human review.",
    };
  }

  function analyze(signalId) {
    const signal = requireSignal(signalId);
    if (signal.status === "dismissed") fail("dismissed", "This signal was dismissed.");
    const analysis = computeAnalysis(signal);
    db.prepare("UPDATE change_signals SET analysis=?,analyzed_at=?,status='analyzed' WHERE id=?").run(JSON.stringify(analysis), now(), signalId);
    audit?.("change_signal.analyzed", signalId, { facts: analysis.affectedFacts.length, runnable: analysis.regressionPlan.run.length });
    return present(getRow(signalId));
  }

  /** A human-supplied new statement for an existing approved fact, filed as a
   * PENDING revision. Returns the before/after so it can be reviewed. */
  function proposeRevision({ signalId, semanticId, statement, provenance = "DOCUMENTED", proposedBy }) {
    const signal = requireSignal(signalId);
    if (signal.status === "dismissed") fail("dismissed", "This signal was dismissed.");
    if (typeof statement !== "string" || !statement.trim()) fail("invalid_revision", "The revised statement is empty.");
    if (containsSecret(statement)) fail("secret_in_statement", "Remove credentials from the statement.");
    if (!PROVENANCE_VALUES.includes(provenance)) fail("invalid_revision", `Provenance must be one of: ${PROVENANCE_VALUES.join(", ")}.`);
    const target = knowledge.resolveSemanticId(semanticId);
    const approved = target && db.prepare("SELECT * FROM knowledge_items WHERE semantic_id=? AND status='approved'").get(target.semantic_id);
    if (!approved) fail("no_approved_fact", "Only an existing approved fact can be revised from a signal.");
    const featureName = db.prepare("SELECT name, description FROM features WHERE id=?").get(approved.feature_id);
    const pending = knowledge.proposeItem({
      semanticId: approved.semantic_id, type: approved.type, featureName: featureName.name, featureDescription: featureName.description,
      title: approved.title, statement: statement.trim(), doesNotMean: approved.does_not_mean, provenance,
      source: { title: signal.title, url: signal.source_ref ?? undefined, author: proposedBy ?? signal.submitted_by },
    });
    if (pending.id === approved.id) return { unchanged: true, before: approved.statement, after: approved.statement, item: null };
    db.prepare("INSERT OR IGNORE INTO change_signal_items(id,signal_id,knowledge_item_id,relation,created_at) VALUES(?,?,?,'proposes',?)")
      .run(randomUUID(), signalId, pending.id, now());
    audit?.("change_signal.revision_proposed", signalId, { semanticId: approved.semantic_id, itemId: pending.id });
    return { unchanged: false, before: approved.statement, after: pending.statement, item: { id: pending.id, semanticId: pending.semantic_id, version: pending.version, status: pending.status } };
  }

  /** "This approved fact may be out of date because of this signal." Human
   * only. Informational: the fact stays approved and tests keep their status. */
  function flagForReview({ signalId, itemId, note = null, actor }) {
    requireHumanApprover(actor);
    requireSignal(signalId);
    const item = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(itemId);
    if (!item || item.status !== "approved") fail("not_approved", "Only an approved fact can be flagged for review.");
    const existing = db.prepare("SELECT * FROM knowledge_review_flags WHERE knowledge_item_id=? AND signal_id=?").get(itemId, signalId);
    if (existing) return { ...existing, duplicate: true };
    const id = randomUUID();
    db.prepare("INSERT INTO knowledge_review_flags(id,knowledge_item_id,signal_id,note,status,raised_by,raised_at) VALUES(?,?,?,?,'open',?,?)")
      .run(id, itemId, signalId, note ? redactText(note) : null, actor, now());
    audit?.("knowledge.review_flagged", id, { itemId, signalId, actor });
    return { ...db.prepare("SELECT * FROM knowledge_review_flags WHERE id=?").get(id), duplicate: false };
  }

  function resolveFlag({ flagId, resolution, note = null, actor }) {
    requireHumanApprover(actor);
    if (!RESOLUTIONS.includes(resolution)) fail("invalid_resolution", `Resolution must be one of: ${RESOLUTIONS.join(", ")}.`);
    const changed = db
      .prepare("UPDATE knowledge_review_flags SET status='resolved',resolution=?,resolved_by=?,resolved_at=?,resolution_note=? WHERE id=? AND status='open'")
      .run(resolution, actor, now(), note ? redactText(note) : null, flagId).changes;
    if (!changed) fail("not_open", "That review flag is not open.");
    audit?.("knowledge.review_flag_resolved", flagId, { resolution, actor });
    return db.prepare("SELECT * FROM knowledge_review_flags WHERE id=?").get(flagId);
  }

  function dismiss({ signalId, note = null, actor }) {
    requireHumanApprover(actor);
    requireSignal(signalId);
    db.prepare("UPDATE change_signals SET status='dismissed',dismissed_by=?,dismissed_at=?,dismissal_note=? WHERE id=?")
      .run(actor, now(), note ? redactText(note) : null, signalId);
    audit?.("change_signal.dismissed", signalId, { actor });
    return present(getRow(signalId));
  }

  /** The reviewable knowledge diff for a signal: each affected approved fact
   * with its pending revisions (before → after) and its review flags. */
  function diff(signalId) {
    const signal = requireSignal(signalId);
    const proposed = db
      .prepare(
        `SELECT knowledge_items.* FROM change_signal_items JOIN knowledge_items ON knowledge_items.id = change_signal_items.knowledge_item_id
         WHERE change_signal_items.signal_id=? AND change_signal_items.relation='proposes' ORDER BY knowledge_items.created_at`,
      )
      .all(signalId);
    const flags = db.prepare("SELECT * FROM knowledge_review_flags WHERE signal_id=? ORDER BY raised_at").all(signalId);
    const revisions = proposed.map((item) => {
      const before = db.prepare("SELECT statement FROM knowledge_items WHERE semantic_id=? AND status IN ('approved','superseded') AND version<? ORDER BY version DESC LIMIT 1").get(item.semantic_id, item.version);
      return { itemId: item.id, semanticId: item.semantic_id, version: item.version, status: item.status, before: before?.statement ?? null, after: item.statement };
    });
    return { signalId: signal.id, revisions, flags };
  }

  function get(signalId) {
    const signal = present(requireSignal(signalId));
    return { signal, diff: diff(signalId) };
  }

  function list({ status = null } = {}) {
    const rows = status
      ? db.prepare("SELECT * FROM change_signals WHERE status=? ORDER BY received_at DESC").all(status)
      : db.prepare("SELECT * FROM change_signals ORDER BY received_at DESC").all();
    return rows.map((row) => {
      const analysis = row.analysis ? JSON.parse(row.analysis) : null;
      return {
        id: row.id, kind: row.kind, title: row.title, status: row.status, source: row.source, sourceRef: row.source_ref,
        occurredAt: row.occurred_at, receivedAt: row.received_at, submittedBy: row.submitted_by, analyzedAt: row.analyzed_at,
        affectedFacts: analysis?.affectedFacts.length ?? null, runnableTests: analysis?.regressionPlan.run.length ?? null,
      };
    });
  }

  /** Approved facts that should be looked at again: volatile by nature
   * (observed/inferred/assumed, or scoped to a tenant/config, or with an end
   * date) and not reviewed for a while, or past their end date. */
  function staleFacts({ olderThanDays = 90, nowMs = Date.now() } = {}) {
    const cutoff = nowMs - olderThanDays * 86400000;
    return db
      .prepare(
        `SELECT knowledge_items.id, semantic_id, title, provenance, decided_at, effective_until, applies_to, features.name AS feature
         FROM knowledge_items JOIN features ON features.id = knowledge_items.feature_id
         WHERE status='approved' ORDER BY decided_at`,
      )
      .all()
      .flatMap((row) => {
        const reasons = [];
        const decided = Date.parse(row.decided_at || "");
        const volatile = ["OBSERVED", "INFERRED", "ASSUMED"].includes(row.provenance) || row.applies_to || row.effective_until;
        if (row.effective_until && Date.parse(row.effective_until) < nowMs) reasons.push("past its end date");
        if (volatile && Number.isFinite(decided) && decided < cutoff) reasons.push(`not reviewed for ${Math.floor((nowMs - decided) / 86400000)} days`);
        return reasons.length ? [{ itemId: row.id, semanticId: row.semantic_id, feature: row.feature, title: row.title, provenance: row.provenance, reasons }] : [];
      });
  }

  return { submit, analyze, get, list, proposeRevision, flagForReview, resolveFlag, dismiss, diff, staleFacts, SIGNAL_KINDS };
}
