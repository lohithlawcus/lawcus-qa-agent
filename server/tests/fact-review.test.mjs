import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openKnowledge, KnowledgeError, validateScope, factApplies, AUTHORITY_RANK, isExpectation } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openFactCards } from "../core/fact-cards.mjs";
import { openChangeSignals } from "../core/change-signals.mjs";
import { seedLawcusKnowledge } from "../knowledge/lawcus-seed.mjs";
import { seedLawcusNativeCases } from "../testbook/lawcus-native-cases.mjs";
import { loginTestCases } from "../core/runner.mjs";

process.env.QA_FORBID_LIVE = "1";
const HUMAN = "operator:tester";

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-facts-"));
  try {
    const { db, audit } = openStore(dir);
    const knowledge = openKnowledge(db, audit);
    const testbook = openTestBook(db, audit);
    return fn({ db, audit, knowledge, testbook, cards: openFactCards(db, { knowledge, testbook }), signals: openChangeSignals(db, audit, { knowledge, testbook }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const item = (over = {}) => ({
  semanticId: "BR-SAMPLE-RULE-001", type: "BUSINESS_RULE", featureName: "Contacts", featureDescription: "d",
  title: "Sample rule", statement: "The sample rule statement.", provenance: "DOCUMENTED",
  source: { title: "Release notes 4.2", url: "https://example.test/rel/42", author: "PM" }, ...over,
});
const count = (db) => db.prepare("SELECT COUNT(*) n FROM knowledge_items").get().n;
const approve = (kb, i) => kb.approveItem(i.id, HUMAN);

// ---------- a source is required ----------

test("a new fact needs a source with a title; nothing is stored when it is missing", () => {
  withApp(({ knowledge, db }) => {
    for (const source of [undefined, null, {}, { title: "" }, { title: "   " }, { url: "https://x.test" }]) {
      assert.throws(() => knowledge.proposeItem(item({ semanticId: "BR-NOSRC-RULE-001", source })), (e) => e.code === "source_required", JSON.stringify(source));
    }
    assert.equal(count(db), 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM knowledge_sources").get().n, 0, "a refused proposal ingests no source either");
  });
});

test("re-proposing an existing fact needs no source again (existing facts are not re-checked)", () => {
  withApp(({ knowledge, db }) => {
    const first = knowledge.proposeItem(item());
    assert.equal(knowledge.proposeItem({ ...item(), source: undefined }).id, first.id);
    assert.equal(count(db), 1);
  });
});

// Mirrors server startup: the Authentication cases first (the seed cites them), then native cases, then Knowledge.
function seedLikeStartup({ testbook, knowledge }) {
  testbook.syncCases({ featureName: "Authentication", featureDescription: "d", suiteName: "login-essentials", suiteDescription: "d", priority: "normal", entries: loginTestCases });
  seedLawcusNativeCases(testbook);
  seedLawcusKnowledge(knowledge);
}

test("the real seed on a fresh database leaves no fact without a source", () => {
  withApp((app) => {
    seedLikeStartup(app);
    assert.deepEqual(app.cards.unsourcedFacts(), []);
  });
});

test("seeding again (every server start) adds no rows and no source rows", () => {
  withApp((app) => {
    seedLikeStartup(app);
    const snapshot = () => ["knowledge_items", "knowledge_sources", "behavior_graph_edges"].map((t) => app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
    const before = snapshot();
    seedLawcusKnowledge(app.knowledge);
    seedLawcusKnowledge(app.knowledge);
    assert.deepEqual(snapshot(), before);
  });
});

// ---------- scope ----------

test("validateScope accepts a strict object of name lists and rejects everything else", () => {
  assert.equal(validateScope(null), null);
  assert.equal(validateScope(undefined), null);
  assert.equal(validateScope({}), null, "an empty scope means everywhere");
  assert.deepEqual(JSON.parse(validateScope({ roles: [" admin ", "admin", "owner"], environments: ["lawcus"] })), { roles: ["admin", "owner"], environments: ["lawcus"] });
  const bad = [
    "admin", [], ["admin"], { role: ["admin"] }, { roles: "admin" }, { roles: [] }, { roles: [1] }, { roles: [""] },
    { roles: Array.from({ length: 21 }, (_, i) => `r${i}`) }, { roles: ["x".repeat(101)] }, { roles: ["admin"], extra: ["y"] },
  ];
  for (const scope of bad) assert.throws(() => validateScope(scope), (e) => e instanceof KnowledgeError && e.code === "invalid_scope", JSON.stringify(scope));
});

test("a fact's scope is stored, shown on its card, and an invalid scope creates nothing", () => {
  withApp(({ knowledge, cards, db }) => {
    const scoped = knowledge.proposeItem(item({ scope: { roles: ["admin"], configurations: ["billing:tax-inclusive"] } }));
    assert.deepEqual(cards.factCard(scoped.id).appliesWhere.scope, { roles: ["admin"], configurations: ["billing:tax-inclusive"] });
    assert.equal(cards.factCard(scoped.id).appliesWhere.unscoped, false);
    assert.throws(() => knowledge.proposeItem(item({ semanticId: "BR-BAD-SCOPE-001", scope: { roles: [] } })), (e) => e.code === "invalid_scope");
    assert.equal(count(db), 1);
  });
});

test("factApplies: unscoped applies everywhere; a scoped fact needs every key matched, and unknown is not yes", () => {
  assert.equal(factApplies({ scope: null }, {}), true);
  assert.equal(factApplies({}, { roles: ["admin"] }), true);
  const admin = { scope: JSON.stringify({ roles: ["admin", "owner"] }) };
  assert.equal(factApplies(admin, { roles: ["admin"] }), true);
  assert.equal(factApplies(admin, { roles: "owner" }), true, "a single name works too");
  assert.equal(factApplies(admin, { roles: ["viewer"] }), false);
  assert.equal(factApplies(admin, {}), false, "a context that says nothing about roles does not qualify");
  const both = { scope: { roles: ["admin"], environments: ["lawcus"] } };
  assert.equal(factApplies(both, { roles: ["admin"], environments: ["lawcus"] }), true);
  assert.equal(factApplies(both, { roles: ["admin"], environments: ["prod-usa"] }), false);
  assert.equal(factApplies(both, { roles: ["admin"] }), false);
});

// ---------- authority ----------

test("expectations (product-approved, documented) outrank observations; observed is not expected", () => {
  assert.ok(AUTHORITY_RANK.PRODUCT_APPROVED > AUTHORITY_RANK.DOCUMENTED && AUTHORITY_RANK.DOCUMENTED > AUTHORITY_RANK.OBSERVED);
  assert.ok(AUTHORITY_RANK.OBSERVED > AUTHORITY_RANK.INFERRED && AUTHORITY_RANK.INFERRED > AUTHORITY_RANK.ASSUMED);
  assert.deepEqual(["PRODUCT_APPROVED", "DOCUMENTED", "OBSERVED", "INFERRED", "ASSUMED"].map(isExpectation), [true, true, false, false, false]);
});

test("weaker evidence cannot silently replace a stronger approved fact; a justified acknowledgement can", () => {
  withApp(({ knowledge, db }) => {
    const v1 = approve(knowledge, knowledge.proposeItem(item()));
    const observed = knowledge.proposeItem(item({ provenance: "OBSERVED", statement: "The tenant returned something else.", source: { title: "Live run" } }));
    const status = (id) => db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(id).status;
    assert.throws(() => knowledge.approveItem(observed.id, HUMAN), (e) => e.code === "lower_authority" && /DOCUMENTED/.test(e.message));
    assert.throws(() => knowledge.approveItem(observed.id, HUMAN, "ok", {}), (e) => e.code === "lower_authority");
    assert.throws(() => knowledge.approveItem(observed.id, HUMAN, null, { acceptLowerAuthority: true }), (e) => e.code === "lower_authority", "an acknowledgement needs a reason");
    assert.throws(() => knowledge.approveItem(observed.id, HUMAN, "   ", { acceptLowerAuthority: true }), (e) => e.code === "lower_authority");
    assert.equal(status(observed.id), "pending_review");
    assert.equal(status(v1.id), "approved");
    knowledge.approveItem(observed.id, HUMAN, "Product confirmed the documented rule is out of date.", { acceptLowerAuthority: true });
    assert.equal(status(observed.id), "approved");
    assert.equal(status(v1.id), "superseded");
  });
});

test("equal or higher authority approves normally, and rejecting a weaker revision needs no acknowledgement", () => {
  withApp(({ knowledge, db }) => {
    approve(knowledge, knowledge.proposeItem(item({ provenance: "OBSERVED" })));
    const documented = knowledge.proposeItem(item({ provenance: "DOCUMENTED", statement: "A documented rule." }));
    assert.doesNotThrow(() => knowledge.approveItem(documented.id, HUMAN));
    const weaker = knowledge.proposeItem(item({ provenance: "ASSUMED", statement: "A guess." }));
    assert.doesNotThrow(() => knowledge.rejectItem(weaker.id, HUMAN, "no"));
    assert.equal(db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(weaker.id).status, "rejected");
  });
});

// ---------- the fact card ----------

test("a fact card answers: who approved it, where it applies, what supports it, which tests assert it, is it superseded", () => {
  withApp(({ knowledge, testbook, cards }) => {
    testbook.syncCases({ featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d",
      entries: { "c.a": { source: "s1", definition: { id: "c.a", name: "A", layer: "both", risk: "normal", status: "approved" } }, "c.b": { source: "s2", definition: { id: "c.b", name: "B", layer: "both", risk: "normal", status: "approved" } } } });
    testbook.setAutomationReadiness("c.a", "ready");
    testbook.setAutomationReadiness("c.b", "quarantined", "known broken");
    const proposed = knowledge.proposeItem(item({ relatedTests: ["c.a", "c.b"], apiContracts: ["lawcus.contacts.create"], appliesTo: ["contact"], scope: { environments: ["lawcus"] }, effectiveFrom: "2026-09", release: "4.2" }));
    knowledge.approveItem(proposed.id, HUMAN, "checked against the release notes");
    const card = cards.factCard("BR-SAMPLE-RULE-001");
    assert.equal(card.id, proposed.id);
    assert.equal(card.status, "approved");
    assert.equal(card.derivedStatus, "current");
    assert.deepEqual(card.approval && [card.approval.by, card.approval.note], [HUMAN, "checked against the release notes"]);
    assert.ok(card.approval.at);
    assert.deepEqual(card.authority, { provenance: "DOCUMENTED", rank: AUTHORITY_RANK.DOCUMENTED, kind: "expected" });
    assert.deepEqual(card.source && [card.source.title, card.source.url, card.source.author], ["Release notes 4.2", "https://example.test/rel/42", "PM"]);
    assert.equal(card.evidenceGap, false);
    assert.deepEqual(card.appliesWhere.scope, { environments: ["lawcus"] });
    assert.deepEqual(card.appliesWhere.recordKinds, ["contact"]);
    assert.equal(card.appliesWhere.release, "4.2");
    assert.deepEqual(card.assertedByTests.map((t) => [t.externalId, t.runnable]), [["c.a", true], ["c.b", false]]);
    assert.equal(card.assertedByTests[1].quarantineReason, "known broken");
    assert.deepEqual(card.apiContracts, ["lawcus.contacts.create"]);
    assert.deepEqual(card.supersession, { supersededBy: null, supersedes: null });
    assert.equal(card.history.length, 1);
  });
});

test("the card resolves an item id, a semantic id and an alias; an unknown reference gives null", () => {
  withApp(({ knowledge, cards }) => {
    const first = knowledge.proposeItem(item());
    knowledge.proposeItem(item({ semanticId: "BR-SAMPLE-RENAMED-001" })); // same statement -> alias
    for (const ref of [first.id, "BR-SAMPLE-RULE-001", "BR-SAMPLE-RENAMED-001"]) assert.equal(cards.factCard(ref).id, first.id, ref);
    assert.deepEqual(cards.factCard(first.id).aliases.map((a) => a.semanticId), ["BR-SAMPLE-RENAMED-001"]);
    for (const ref of ["BR-NOPE-NOPE-001", randomUUID(), "", undefined, null, 5]) assert.equal(cards.factCard(ref), null, String(ref));
  });
});

test("history shows every version; a superseded card points at what replaced it", () => {
  withApp(({ knowledge, cards }) => {
    const v1 = approve(knowledge, knowledge.proposeItem(item()));
    const v2 = approve(knowledge, knowledge.proposeItem(item({ statement: "The revised statement." })));
    const old = cards.factCard(v1.id);
    assert.equal(old.derivedStatus, "superseded");
    assert.deepEqual(old.supersession.supersededBy, { id: v2.id, version: 2 });
    const current = cards.factCard("BR-SAMPLE-RULE-001");
    assert.equal(current.id, v2.id, "a semantic id resolves to its current version");
    assert.deepEqual(current.history.map((h) => [h.version, h.status]), [[1, "superseded"], [2, "approved"]]);
    assert.equal(current.supersession.supersedes, v1.id);
  });
});

test("each state is shown distinctly: current, under review, stale, pending, rejected, retired duplicate, superseded", () => {
  withApp(({ knowledge, signals, cards, db }) => {
    const mk = (id, over = {}) => knowledge.proposeItem(item({ semanticId: id, statement: `Statement of ${id}.`, ...over }));
    const current = approve(knowledge, mk("BR-STATE-CURRENT-001"));
    const flagged = approve(knowledge, mk("BR-STATE-FLAGGED-001"));
    const stale = approve(knowledge, mk("BR-STATE-STALE-001"));
    db.prepare("UPDATE knowledge_items SET effective_until=? WHERE id=?").run("2020-01-01", stale.id);
    const pending = mk("BR-STATE-PENDING-001");
    const rejected = mk("BR-STATE-REJECTED-001");
    knowledge.rejectItem(rejected.id, HUMAN, "wrong");
    const dup = mk("BR-STATE-DUP-001", { statement: "Statement of BR-STATE-CURRENT-001." }); // duplicate -> returns existing
    assert.equal(dup.id, current.id);
    const retired = mk("BR-STATE-RETIRED-001");
    db.prepare("UPDATE knowledge_items SET status='rejected', decision_note='Duplicate of BR-STATE-CURRENT-001 (x); retired' WHERE id=?").run(retired.id);
    const signal = signals.submit({ kind: "qa_note", title: "n", body: "b", submittedBy: HUMAN });
    signals.flagForReview({ signalId: signal.id, itemId: flagged.id, actor: HUMAN });
    const states = Object.fromEntries(cards.listFacts().map((f) => [f.semanticId, f.derivedStatus]));
    assert.deepEqual(states, {
      "BR-STATE-CURRENT-001": "current", "BR-STATE-FLAGGED-001": "under_review", "BR-STATE-STALE-001": "stale",
      "BR-STATE-PENDING-001": "pending", "BR-STATE-REJECTED-001": "rejected", "BR-STATE-RETIRED-001": "retired_duplicate",
    });
    assert.equal(cards.factCard(pending.id).derivedStatus, "pending");
  });
});

test("a fact with no source (an older row) shows an evidence gap, and is listed as unsourced", () => {
  withApp(({ knowledge, cards, db }) => {
    const legacy = knowledge.proposeItem(item({ semanticId: "BR-LEGACY-RULE-001" }));
    db.prepare("UPDATE knowledge_items SET source_id=NULL WHERE id=?").run(legacy.id);
    approve(knowledge, legacy);
    knowledge.proposeItem(item({ semanticId: "BR-SOURCED-RULE-001", statement: "Another." }));
    const card = cards.factCard(legacy.id);
    assert.equal(card.source, null);
    assert.equal(card.evidenceGap, true);
    assert.deepEqual(cards.unsourcedFacts().map((f) => f.semanticId), ["BR-LEGACY-RULE-001"]);
    assert.equal(cards.listFacts().find((f) => f.semanticId === "BR-LEGACY-RULE-001").hasSource, false);
  });
});

test("listFacts gives one row per fact (its approved version), and filters by state and feature", () => {
  withApp(({ knowledge, cards }) => {
    const v1 = approve(knowledge, knowledge.proposeItem(item()));
    knowledge.proposeItem(item({ statement: "A pending revision." }));
    approve(knowledge, knowledge.proposeItem(item({ semanticId: "BR-OTHER-RULE-001", featureName: "Leads", statement: "Leads rule." })));
    const all = cards.listFacts();
    assert.equal(all.length, 2);
    assert.equal(all.find((f) => f.semanticId === "BR-SAMPLE-RULE-001").id, v1.id, "the approved version represents the fact");
    assert.deepEqual(cards.listFacts({ feature: "Leads" }).map((f) => f.semanticId), ["BR-OTHER-RULE-001"]);
    assert.equal(cards.listFacts({ status: "current" }).length, 2);
    assert.equal(cards.listFacts({ status: "pending" }).length, 0);
  });
});

test("a fact whose approved version is not its first is represented by that approved version", () => {
  withApp(({ knowledge, cards }) => {
    approve(knowledge, knowledge.proposeItem(item()));
    const v2 = approve(knowledge, knowledge.proposeItem(item({ statement: "Second." })));
    knowledge.proposeItem(item({ statement: "Third, still pending." }));
    const rows = cards.listFacts();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].id, rows[0].derivedStatus], [v2.id, "current"]);
  });
});

test("a flag on an older version keeps the fact under review in BOTH the list and the card, until it is resolved", () => {
  withApp(({ knowledge, signals, cards }) => {
    const v1 = approve(knowledge, knowledge.proposeItem(item()));
    const signal = signals.submit({ kind: "qa_note", title: "n", body: "b", submittedBy: HUMAN });
    const flag = signals.flagForReview({ signalId: signal.id, itemId: v1.id, actor: HUMAN });
    const v2 = approve(knowledge, knowledge.proposeItem(item({ statement: "A newer statement." })));
    assert.equal(cards.factCard(v2.id).derivedStatus, "under_review");
    assert.equal(cards.listFacts().find((f) => f.semanticId === "BR-SAMPLE-RULE-001").derivedStatus, "under_review", "the list agrees with the card");
    signals.resolveFlag({ flagId: flag.id, resolution: "revised", actor: HUMAN });
    assert.equal(cards.factCard(v2.id).derivedStatus, "current");
    assert.equal(cards.listFacts().find((f) => f.semanticId === "BR-SAMPLE-RULE-001").derivedStatus, "current");
  });
});

// ---------- schema and wiring ----------

test("the migration is recorded, and the routes and the acknowledgement flag are wired", () => {
  withApp(({ db, knowledge }) => {
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=24").get());
    assert.ok(db.prepare("PRAGMA table_info(knowledge_items)").all().some((c) => c.name === "scope"));
    const row = knowledge.proposeItem(item());
    assert.equal(db.prepare("UPDATE knowledge_items SET scope='{\"roles\":[\"admin\"]}' WHERE id=?").run(row.id).changes, 1, "valid JSON is accepted");
    assert.throws(() => db.prepare("UPDATE knowledge_items SET scope='not json' WHERE id=?").run(row.id), /CHECK constraint failed/, "the column refuses non-JSON");
  });
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(index, /pathname === "\/knowledge\/facts"/);
  assert.match(index, /pathname === "\/knowledge\/unsourced"/);
  assert.match(index, /acceptLowerAuthority: input\.acceptLowerAuthority === true/);
  assert.match(index, /error\?\.code === "lower_authority"\) \{ json\(res, 409/);
});
