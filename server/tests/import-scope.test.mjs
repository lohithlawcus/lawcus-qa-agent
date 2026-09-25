import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openKnowledge, canonicalScope } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openFactCards } from "../core/fact-cards.mjs";
import { openChangeSignals } from "../core/change-signals.mjs";
import { parseKnowledgeMarkdown } from "../core/knowledge-import.mjs";

process.env.QA_FORBID_LIVE = "1";
const HUMAN = "operator:tester";

const doc = (scopeLines = [], extra = "") => `## Feature: Billing
Description: Invoicing.

### BUSINESS_RULE: BR-BILLING-TAX-001
Title: Tax shows on invoices
Provenance: DOCUMENTED
Statement: Tax is shown as its own line on an invoice.
${scopeLines.map((l) => `${l}\n`).join("")}Source Title: Billing guide
${extra}`;

const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

// ---------- parsing ----------

test("a Scope line becomes a strict scope object on the item; no line means no scope", () => {
  const cases = [
    [["Scope: roles=admin,owner; environments=lawcus"], { roles: ["admin", "owner"], environments: ["lawcus"] }],
    [["Scope: roles=admin"], { roles: ["admin"] }],
    [["Scope: Roles = admin , owner ;  ENVIRONMENTS=lawcus ;"], { roles: ["admin", "owner"], environments: ["lawcus"] }],
    [["Scope: configurations=billing tax inclusive, billing tax exclusive; tenants=acme"], { configurations: ["billing tax inclusive", "billing tax exclusive"], tenants: ["acme"] }],
    [[], null],
  ];
  for (const [lines, expected] of cases) {
    const { items, errors } = parseKnowledgeMarkdown(doc(lines));
    assert.deepEqual(errors, [], lines.join());
    assert.deepEqual(items[0].scope, expected, lines.join());
  }
});

test("every bad scope is a line error on the SCOPE line, names the fact, and keeps that item out of the batch", () => {
  const bad = [
    ["Scope:", /Scope: is empty/],
    ["Scope: ;", /Scope: is empty/],
    ["Scope: admin", /look like "roles=admin,owner"/],
    ["Scope: roles=", /look like "roles=admin,owner"/],
    ["Scope: roles=admin; owner", /look like "roles=admin,owner"/],
    ["Scope: roles=,,", /non-empty list/],
    ["Scope: role=admin", /Unknown scope key "role"/],
    ["Scope: users=admin", /Unknown scope key "users"/],
    ["Scope: roles=a; roles=b", /more than once/],
    [`Scope: roles=${Array.from({ length: 21 }, (_, i) => `r${i}`).join(",")}`, /at most 20/],
    [`Scope: roles=${"x".repeat(101)}`, /non-empty list \(at most 20\) of names/],
  ];
  for (const [scopeLine, pattern] of bad) {
    const text = doc([scopeLine]);
    const { items, errors } = parseKnowledgeMarkdown(text);
    assert.equal(errors.length, 1, `${scopeLine.slice(0, 40)} -> ${JSON.stringify(errors)}`);
    assert.match(errors[0].message, pattern, scopeLine.slice(0, 40));
    assert.match(errors[0].message, /"BR-BILLING-TAX-001"/);
    assert.equal(errors[0].line, lineOf(text, scopeLine.slice(0, 12)), "the line of the Scope field itself");
    assert.deepEqual(items, [], "the item is not returned");
  }
});

test("a repeated Scope line is an error on the second line, not a silent 'last one wins'", () => {
  const text = doc(["Scope: roles=admin", "Scope: roles=viewer"]);
  const { errors } = parseKnowledgeMarkdown(text);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /"Scope:" appears more than once/);
  assert.equal(errors[0].line, text.split("\n").lastIndexOf("Scope: roles=viewer") + 1);
});

test("a relationship has no scope", () => {
  const text = `## Feature: A\nDescription: d\n\n## Feature: B\nDescription: d\n\n### EDGE: DEPENDS_ON\nFrom: A\nTo: B\nRationale: r\nScope: roles=admin\n`;
  const { errors } = parseKnowledgeMarkdown(text);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Unrecognized field "Scope:" for this EDGE/);
});

test("one bad scope fails the batch's errors list even when other items are fine (the importer applies none of a broken batch)", () => {
  const text = `${doc(["Scope: roles=admin"])}\n### BUSINESS_RULE: BR-BILLING-LATE-001\nTitle: Late fee\nProvenance: DOCUMENTED\nStatement: A late fee applies.\nScope: nonsense\nSource Title: Guide\n`;
  const { items, errors } = parseKnowledgeMarkdown(text);
  assert.equal(items.length, 1, "the good item parses");
  assert.equal(errors.length, 1, "and the bad one is reported, so a caller that refuses batches with errors imports nothing");
});

test("the shipped template documents Scope and its example item carries one that parses", () => {
  const template = readFileSync(new URL("../knowledge/IMPORT_TEMPLATE.md", import.meta.url), "utf8");
  assert.match(template, /`Scope:` \(optional\)/);
  assert.match(template, /Scope: roles=owner,admin; environments=lawcus/);
  const parsed = parseKnowledgeMarkdown(template.slice(template.indexOf("---\n") + 4));
  assert.deepEqual(parsed.errors.filter((e) => /Scope/.test(e.message)), []);
  assert.deepEqual(parsed.items.find((i) => i.semanticId === "BR-BILLING-TIMEKEEPER-REQUIRED-001").scope, { roles: ["owner", "admin"], environments: ["lawcus"] });
  const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<code>Scope:<\/code> is optional/);
});

// ---------- a scope is part of what a fact means ----------

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-import-scope-"));
  try {
    const { db, audit } = openStore(dir);
    const knowledge = openKnowledge(db, audit);
    const testbook = openTestBook(db, audit);
    return fn({ db, audit, knowledge, testbook, cards: openFactCards(db, { knowledge, testbook }), signals: openChangeSignals(db, audit, { knowledge, testbook }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const propose = (kb, over = {}) => kb.proposeItem({ semanticId: "BR-BILLING-TAX-001", type: "BUSINESS_RULE", featureName: "Billing", featureDescription: "d", title: "Tax", statement: "Tax is shown as its own line on an invoice.", provenance: "DOCUMENTED", source: { title: "Guide" }, ...over });
const imported = (kb, text) => parseKnowledgeMarkdown(text).items.map((item) => kb.proposeItem(item));

test("an imported scope is stored, canonical, parsed for the inbox, and shown on the fact card", () => {
  withApp(({ knowledge, cards }) => {
    const [item] = imported(knowledge, doc(["Scope: environments=lawcus; roles=owner,admin"]));
    assert.equal(item.scope, '{"environments":["lawcus"],"roles":["owner","admin"]}', "stored as the validated object");
    assert.deepEqual(knowledge.inboxItems()[0].scope, { environments: ["lawcus"], roles: ["owner", "admin"] }, "the inbox sees it as data, not a JSON string");
    assert.deepEqual(cards.factCard(item.id).appliesWhere.scope, { environments: ["lawcus"], roles: ["owner", "admin"] });
    assert.equal(knowledge.inboxItems().length, 1);
    assert.equal(knowledge.approvedByFeature().length, 0, "still pending");
  });
});

test("the same scope written in another order is the same scope; a different scope is a different one", () => {
  assert.equal(canonicalScope({ roles: ["b", "a"], environments: ["x"] }), canonicalScope('{"environments":["x"],"roles":["a","b","a"]}'));
  assert.notEqual(canonicalScope({ roles: ["a"] }), canonicalScope({ roles: ["b"] }));
  assert.equal(canonicalScope(null), null);
  assert.equal(canonicalScope({}), null);
  assert.equal(canonicalScope(undefined), null);
});

test("re-importing the same fact with the same scope changes nothing; a different or newly added scope files a pending revision", () => {
  withApp(({ knowledge, db }) => {
    const [first] = imported(knowledge, doc(["Scope: roles=admin,owner"]));
    const [again] = imported(knowledge, doc(["Scope: roles=owner,admin"]));
    assert.equal(again.id, first.id, "the same scope in another order");
    knowledge.approveItem(first.id, HUMAN);
    const [narrowed] = imported(knowledge, doc(["Scope: roles=admin"]));
    assert.notEqual(narrowed.id, first.id);
    assert.deepEqual([narrowed.version, narrowed.status, narrowed.semantic_id], [2, "pending_review", "BR-BILLING-TAX-001"]);
    assert.equal(db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(first.id).status, "approved", "the approved fact stays in force");
    // an unscoped fact that gains a scope
    const [plain] = imported(knowledge, doc([]).replace("BR-BILLING-TAX-001", "BR-BILLING-PLAIN-001").replace("Tax is shown", "Plain tax is shown"));
    knowledge.approveItem(plain.id, HUMAN);
    const [gained] = imported(knowledge, doc(["Scope: roles=admin"]).replace("BR-BILLING-TAX-001", "BR-BILLING-PLAIN-001").replace("Tax is shown", "Plain tax is shown"));
    assert.deepEqual([gained.version, gained.status], [2, "pending_review"], "adding a scope is a reviewable change, not a silent no-op");
    assert.equal(gained.scope, '{"roles":["admin"]}');
  });
});

test("the same words for a different scope are a different fact, not a duplicate; the same scope is a duplicate", () => {
  withApp(({ knowledge, db }) => {
    const admin = propose(knowledge, { scope: { roles: ["admin"] } });
    const owner = propose(knowledge, { semanticId: "BR-BILLING-TAX-002", scope: { roles: ["owner"] } });
    const everyone = propose(knowledge, { semanticId: "BR-BILLING-TAX-003" });
    assert.equal(new Set([admin.id, owner.id, everyone.id]).size, 3, "three different facts");
    const sameAsAdmin = propose(knowledge, { semanticId: "BR-BILLING-TAX-004", scope: { roles: ["admin"] } });
    assert.equal(sameAsAdmin.id, admin.id, "the same scope is the same fact under a new label");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM knowledge_items").get().n, 3);
  });
});

test("collapsing duplicates never retires a same-words fact whose scope differs", () => {
  withApp(({ knowledge, db }) => {
    const keep = propose(knowledge, { scope: { roles: ["admin"] } });
    const other = db.prepare("INSERT INTO knowledge_items(id,semantic_id,version,type,feature_id,title,statement,provenance,status,created_at,scope) SELECT ?,?,1,type,feature_id,title,statement,provenance,'pending_review',?,? FROM knowledge_items WHERE id=?");
    other.run("other-scope", "BR-BILLING-TAX-010", new Date().toISOString(), '{"roles":["owner"]}', keep.id);
    other.run("same-scope", "BR-BILLING-TAX-011", new Date().toISOString(), '{"roles":["admin"]}', keep.id);
    const report = knowledge.collapseDuplicates();
    assert.deepEqual(report.retired.map((r) => r.semanticId), ["BR-BILLING-TAX-011"], "only the same-scope twin");
  });
});

// ---------- a revision keeps everything except its statement ----------

test("a revision carries a fact's scope, record kinds, preconditions, dates, release and its test and contract links", () => {
  withApp(({ knowledge, testbook, signals, cards, db }) => {
    testbook.syncCases({ featureName: "Billing", featureDescription: "d", suiteName: "s", suiteDescription: "d", entries: { "billing.tax": { source: "s", definition: { id: "billing.tax", name: "Tax", layer: "both", risk: "normal", status: "approved" } } } });
    const original = propose(knowledge, {
      scope: { roles: ["admin"], environments: ["lawcus"] }, appliesTo: ["invoice"], preconditions: ["An invoice exists"],
      expectedBehavior: { existing_invoice: { tax_line: "shown" } }, effectiveFrom: "2026-09", effectiveUntil: "2027-09-30", release: "4.2",
      relatedTests: ["billing.tax"], apiContracts: ["lawcus.invoices.read"], doesNotMean: "It does not compute tax.",
    });
    knowledge.approveItem(original.id, HUMAN);
    const signal = signals.submit({ kind: "release_note", title: "Tax line", body: "BR-BILLING-TAX-001 changes.", submittedBy: HUMAN });
    const result = signals.proposeRevision({ signalId: signal.id, semanticId: "BR-BILLING-TAX-001", statement: "Tax is shown as its own line and as a total.", proposedBy: HUMAN });
    const revised = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(result.item.id);
    assert.equal(revised.statement, "Tax is shown as its own line and as a total.");
    assert.deepEqual(JSON.parse(revised.scope), { roles: ["admin"], environments: ["lawcus"] });
    assert.deepEqual(JSON.parse(revised.applies_to), ["invoice"]);
    assert.deepEqual(JSON.parse(revised.preconditions), ["An invoice exists"]);
    assert.deepEqual(JSON.parse(revised.expected_behavior), { existing_invoice: { tax_line: "shown" } });
    assert.deepEqual([revised.effective_from, revised.effective_until, revised.release, revised.does_not_mean], ["2026-09", "2027-09-30", "4.2", "It does not compute tax."]);
    assert.deepEqual(knowledge.itemLinks(revised.id), { apiContracts: ["lawcus.invoices.read"], relatedTests: ["billing.tax"] });
    // once a person approves it, the CURRENT fact is still scoped and still asserted by its test
    knowledge.approveItem(revised.id, HUMAN);
    const card = cards.factCard("BR-BILLING-TAX-001");
    assert.equal(card.version, 2);
    assert.deepEqual(card.appliesWhere.scope, { roles: ["admin"], environments: ["lawcus"] });
    assert.deepEqual(card.assertedByTests.map((t) => t.externalId), ["billing.tax"]);
    // and the unchanged statement is still recognised as unchanged
    assert.equal(signals.proposeRevision({ signalId: signal.id, semanticId: "BR-BILLING-TAX-001", statement: "Tax is shown as its own line and as a total.", proposedBy: HUMAN }).unchanged, true);
  });
});

test("the reviewer sees a pending fact's scope in the Knowledge inbox and in the approved list", () => {
  const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/<strong>Applies only to<\/strong> \{scopeText\(k\.scope\)\}/g) || []).length, 2);
  assert.match(page, /scope\?: Record<string, string\[\]> \| null;/);
  assert.match(page, /\{k\.version > 1 && <Badge variant="outline">revision v\{k\.version\}<\/Badge>\}/, "a scope-only revision is distinguishable from the fact it revises");
});
