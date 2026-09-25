import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { EDGE_SEMANTICS, impactedFeatures, prerequisiteClosure, planFromKnowledge } from "../core/graph-planner.mjs";
import { planImpactedTest, executeImpactedTest } from "../core/impacted-testing.mjs";
import { seedLawcusKnowledge } from "../knowledge/lawcus-seed.mjs";
import { seedLawcusNativeCases } from "../testbook/lawcus-native-cases.mjs";
import { loginTestCases } from "../core/runner.mjs";
import { randomUUID } from "node:crypto";

process.env.QA_FORBID_LIVE = "1";
const HUMAN = "operator:tester";

const edge = (type, from, to) => ({ type, from_feature: from, to_feature: to });

// ---------- edge semantics ----------

test("every edge type the database allows has declared semantics (none is left as an undirected synonym)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-graph-"));
  try {
    const { db } = openStore(dir);
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='behavior_graph_edges'").get().sql;
    const types = [...sql.match(/type IN \(([^)]*)\)/s)[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    assert.ok(types.length >= 11);
    for (const type of types) {
      assert.ok(EDGE_SEMANTICS[type], `${type} has no semantics`);
      assert.ok(["forward", "reverse", "both", "none"].includes(EDGE_SEMANTICS[type].impact), type);
      assert.ok(EDGE_SEMANTICS[type].meaning.length > 5, type);
    }
    assert.deepEqual(Object.keys(EDGE_SEMANTICS).sort(), [...types].sort(), "no semantics for a type the database does not have");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- directed impact ----------

test("a change flows the way the edge type says, never both ways by default", () => {
  const reach = (edges, from) => [...impactedFeatures(edges, from).keys()].sort();
  // AFFECTS: a change to the source reaches the target, not the reverse
  assert.deepEqual(reach([edge("AFFECTS", "Leads", "Contacts")], "Leads"), ["Contacts"]);
  assert.deepEqual(reach([edge("AFFECTS", "Leads", "Contacts")], "Contacts"), []);
  // DEPENDS_ON: Matters depends on Contacts, so a change to Contacts reaches Matters, not the reverse
  assert.deepEqual(reach([edge("DEPENDS_ON", "Matters", "Contacts")], "Contacts"), ["Matters"]);
  assert.deepEqual(reach([edge("DEPENDS_ON", "Matters", "Contacts")], "Matters"), []);
  assert.deepEqual(reach([edge("REFERENCES", "Invoices", "Matters")], "Matters"), ["Invoices"]);
  assert.deepEqual(reach([edge("REQUIRES_PERMISSION", "Matters", "Permissions")], "Permissions"), ["Matters"]);
  assert.deepEqual(reach([edge("BACKED_BY_API", "Matters", "Matters API")], "Matters API"), ["Matters"]);
  for (const type of ["CREATES", "CONVERTS_TO", "TRIGGERS", "USED_BY"]) assert.deepEqual(reach([edge(type, "A", "B")], "A"), ["B"], type);
  for (const type of ["CREATES", "CONVERTS_TO", "TRIGGERS", "USED_BY"]) assert.deepEqual(reach([edge(type, "A", "B")], "B"), [], type);
  // SHARED_MODEL both ways; TESTED_BY none
  assert.deepEqual(reach([edge("SHARED_MODEL", "A", "B")], "A"), ["B"]);
  assert.deepEqual(reach([edge("SHARED_MODEL", "A", "B")], "B"), ["A"]);
  assert.deepEqual(reach([edge("TESTED_BY", "A", "B")], "A"), []);
  assert.deepEqual(reach([edge("TESTED_BY", "A", "B")], "B"), []);
});

test("impact follows several hops, explains the path, respects the hop limit and survives cycles", () => {
  const edges = [edge("AFFECTS", "A", "B"), edge("AFFECTS", "B", "C"), edge("AFFECTS", "C", "D"), edge("AFFECTS", "D", "E"), edge("AFFECTS", "C", "A")];
  const reached = impactedFeatures(edges, "A");
  assert.deepEqual([...reached.keys()].sort(), ["B", "C", "D"], "three hops by default; A itself is never listed");
  assert.equal(reached.get("C").hops, 2);
  assert.equal(reached.get("C").because, "A AFFECTS B → B AFFECTS C");
  assert.equal(impactedFeatures(edges, "A", 1).size, 1);
  assert.equal(impactedFeatures([], "A").size, 0);
});

// ---------- prerequisites ----------

test("prerequisites come out before what needs them, transitively; only 'requires' edges count", () => {
  const edges = [edge("DEPENDS_ON", "Matters", "Contacts"), edge("DEPENDS_ON", "Contacts", "Custom Fields"), edge("AFFECTS", "Matters", "Invoices"), edge("REFERENCES", "Invoices", "Matters")];
  const closure = prerequisiteClosure(edges, ["Matters"]);
  assert.deepEqual(closure.order, ["Custom Fields", "Contacts", "Matters"]);
  assert.deepEqual(closure.closureOf("Matters").sort(), ["Contacts", "Custom Fields"]);
  assert.deepEqual(closure.closureOf("Contacts"), ["Custom Fields"]);
  assert.deepEqual(closure.closureOf("Custom Fields"), []);
  assert.deepEqual(prerequisiteClosure(edges, ["Invoices"]).order, ["Custom Fields", "Contacts", "Matters", "Invoices"], "REFERENCES is a requirement too");
  assert.deepEqual(prerequisiteClosure([edge("AFFECTS", "A", "B")], ["A"]).closureOf("A"), [], "AFFECTS is not a prerequisite");
  assert.deepEqual(closure.cycles, []);
});

test("a dependency cycle is reported, not looped on", () => {
  const closure = prerequisiteClosure([edge("DEPENDS_ON", "A", "B"), edge("DEPENDS_ON", "B", "A")], ["A"]);
  assert.equal(closure.cycles.length, 1);
  assert.ok(closure.cycles[0].includes("A") && closure.cycles[0].includes("B"));
  assert.ok(closure.closureOf("A").length <= 2);
});

// ---------- planning from approved knowledge ----------

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-graph-plan-"));
  try {
    const { db, audit } = openStore(dir);
    const knowledge = openKnowledge(db, audit);
    const testbook = openTestBook(db, audit);
    return fn({ db, audit, knowledge, testbook });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const caseEntry = (id) => ({ source: `src-${id}`, definition: { id, name: id, layer: "both", risk: "normal", status: "approved" } });
function addCases(testbook, feature, ids, { quarantine = [] } = {}) {
  testbook.syncCases({ featureName: feature, featureDescription: "d", suiteName: "s", suiteDescription: "d", entries: Object.fromEntries(ids.map((id) => [id, caseEntry(id)])) });
  for (const id of ids) {
    if (quarantine.includes(id)) testbook.setAutomationReadiness(id, "quarantined", "broken");
    else testbook.setAutomationReadiness(id, "ready");
  }
}
function approveEdge(knowledge, type, from, to) {
  for (const name of [from, to]) knowledge.ensureFeature(name, "d");
  const proposed = knowledge.proposeEdge({ type, fromFeatureName: from, toFeatureName: to, rationale: "r", source: { title: "s" } });
  return knowledge.approveEdge(proposed.id, HUMAN);
}
const plan = (app, intent, extra = {}) => planFromKnowledge({ intent, knowledge: app.knowledge, testbook: app.testbook, ...extra });
const ids = (p) => p.cells.map((c) => c.externalId);

test("a request that names a feature with no known relations plans that feature alone, and says so", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a", "contacts.b"]);
    const p = plan(app, "Verify Contacts still works");
    assert.deepEqual([p.matched, p.status, p.origin], [true, "ready", "graph"]);
    assert.deepEqual(ids(p), ["contacts.a", "contacts.b"]);
    assert.ok(p.cells.every((c) => c.covered && c.role === "subject" && c.reasons[0] === "Named in the request."));
    assert.deepEqual(p.reviewRequests.map((r) => r.kind), ["no_known_relations"]);
    assert.equal(p.reviewRequests[0].severity, "info");
  });
});

test("an unapproved (pending) relation is a review request and is NOT used to select or order anything", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    addCases(app.testbook, "Leads", ["leads.a"]);
    app.knowledge.proposeEdge({ type: "AFFECTS", fromFeatureName: "Leads", toFeatureName: "Contacts", rationale: "r", source: { title: "s" } });
    const p = plan(app, "Test Leads");
    assert.deepEqual(ids(p), ["leads.a"], "Contacts is not pulled in by an unapproved edge");
    assert.deepEqual(p.reviewRequests.map((r) => r.kind), ["pending_edge"]);
    assert.match(p.reviewRequests[0].message, /Leads AFFECTS Contacts is proposed but not approved yet/);
  });
});

test("an approved edge pulls in what a change reaches, with the reason, and only in its direction", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    addCases(app.testbook, "Leads", ["leads.a"]);
    approveEdge(app.knowledge, "AFFECTS", "Leads", "Contacts");
    const leads = plan(app, "Regression test Leads");
    assert.deepEqual(ids(leads).sort(), ["contacts.a", "leads.a"]);
    const contactsCell = leads.cells.find((c) => c.externalId === "contacts.a");
    assert.equal(contactsCell.role, "impacted");
    assert.match(contactsCell.reasons[0], /Impacted by a change to Leads: Leads AFFECTS Contacts\./);
    assert.deepEqual(ids(plan(app, "Test Contacts")), ["contacts.a"], "the reverse direction is not impacted");
  });
});

test("a prerequisite the check neither creates nor declares as a fixture BLOCKS the plan, and says which check and what", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    addCases(app.testbook, "Matters", ["matters.unknown_setup"]);
    approveEdge(app.knowledge, "DEPENDS_ON", "Matters", "Contacts");
    const p = plan(app, "Verify Matters");
    assert.equal(p.status, "blocked");
    const cell = p.cells.find((c) => c.externalId === "matters.unknown_setup");
    assert.equal(cell.covered, false);
    assert.equal(cell.blockedReason, "prerequisite_unmet");
    assert.deepEqual(cell.prerequisites, [{ prerequisite: "Contacts", mode: "unmet" }]);
    assert.ok(p.blockers.some((b) => b.kind === "prerequisite_unmet" && b.externalId === "matters.unknown_setup" && /needs "Contacts" set up/.test(b.detail)));
    assert.ok(p.blockers.some((b) => b.kind === "nothing_runnable"));
  });
});

test("a check that provisions its own prerequisite, or declares an existing fixture, is not blocked", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    addCases(app.testbook, "Matters", ["matters.create_for_new_contact"]); // CASE_SETUP: selfProvisions Contacts
    approveEdge(app.knowledge, "DEPENDS_ON", "Matters", "Contacts");
    const own = plan(app, "Verify Matters");
    assert.equal(own.status, "ready");
    assert.deepEqual(own.cells[0].prerequisites, [{ prerequisite: "Contacts", mode: "self_provisioned" }]);
    assert.ok(own.cells[0].covered);
    const fixture = plan(app, "Verify Matters", { caseSetup: { "matters.create_for_new_contact": { usesFixtures: ["Contacts"] } } });
    assert.equal(fixture.status, "ready");
    assert.equal(fixture.cells[0].prerequisites[0].mode, "existing_fixture");
    const none = plan(app, "Verify Matters", { caseSetup: {} });
    assert.equal(none.status, "blocked");
  });
});

test("a check that declares it needs no setup is not blocked by a prerequisite; a check that declares nothing still is", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    addCases(app.testbook, "Matters", ["matters.empty_form", "matters.undeclared"]);
    approveEdge(app.knowledge, "DEPENDS_ON", "Matters", "Contacts");
    const p = plan(app, "Verify Matters", { caseSetup: { "matters.empty_form": { needsNoSetup: true } } });
    const byId = Object.fromEntries(p.cells.map((c) => [c.externalId, c]));
    assert.deepEqual(byId["matters.empty_form"].prerequisites, [{ prerequisite: "Contacts", mode: "not_needed" }]);
    assert.equal(byId["matters.empty_form"].covered, true);
    assert.equal(byId["matters.undeclared"].blockedReason, "prerequisite_unmet", "declaring nothing is still unmet");
    assert.equal(p.status, "blocked");
    // `needsNoSetup` must be exactly true; anything else does not excuse a prerequisite
    assert.equal(plan(app, "Verify Matters", { caseSetup: { "matters.empty_form": { needsNoSetup: "yes" } } }).cells.find((c) => c.externalId === "matters.empty_form").blockedReason, "prerequisite_unmet");
  });
});

test("with the real case declarations, 'Verify Matters' is ready once Matters DEPENDS_ON Contacts is approved", () => {
  withApp((app) => {
    app.testbook.syncCases({ featureName: "Authentication", featureDescription: "d", suiteName: "login-essentials", suiteDescription: "d", priority: "normal", entries: loginTestCases });
    seedLawcusNativeCases(app.testbook);
    seedLawcusKnowledge(app.knowledge);
    const pending = app.knowledge.inboxEdges().find((e) => e.from_feature === "Matters" && e.to_feature === "Contacts");
    app.knowledge.approveEdge(pending.id, HUMAN);
    const p = planFromKnowledge({ intent: "Verify Matters", knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(p.status, "ready", JSON.stringify(p.blockers));
    assert.deepEqual(p.cells.map((c) => [c.externalId, c.covered]).sort(), [["matters.create_for_new_contact", true], ["matters.create_mandatory_field_validation", true]]);
    assert.deepEqual(Object.fromEntries(p.cells.map((c) => [c.externalId, c.prerequisites[0].mode])), {
      "matters.create_for_new_contact": "self_provisioned", "matters.create_mandatory_field_validation": "not_needed",
    });
  });
});

test("prerequisite features are ordered first; quarantined checks are listed but do not run", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a", "contacts.broken"], { quarantine: ["contacts.broken"] });
    addCases(app.testbook, "Matters", ["matters.create_for_new_contact"]);
    approveEdge(app.knowledge, "DEPENDS_ON", "Matters", "Contacts");
    approveEdge(app.knowledge, "AFFECTS", "Matters", "Contacts");
    const p = plan(app, "Verify Matters and Contacts");
    assert.equal(p.status, "ready");
    assert.deepEqual(p.prerequisiteOrder, ["Contacts", "Matters"]);
    assert.deepEqual(ids(p), ["contacts.a", "contacts.broken", "matters.create_for_new_contact"], "Contacts' cases come before Matters'");
    const broken = p.cells.find((c) => c.externalId === "contacts.broken");
    assert.deepEqual([broken.covered, broken.blockedReason], [false, "quarantined"]);
    assert.deepEqual(p.quarantined.map((c) => c.externalId), ["contacts.broken"]);
  });
});

test("ordering follows prerequisites, not the alphabet", () => {
  withApp((app) => {
    addCases(app.testbook, "Zeta Base", ["zeta.one"]);
    addCases(app.testbook, "Alpha Top", ["alpha.one"]);
    approveEdge(app.knowledge, "DEPENDS_ON", "Alpha Top", "Zeta Base");
    approveEdge(app.knowledge, "AFFECTS", "Alpha Top", "Zeta Base"); // pulls Zeta Base into the plan from Alpha Top
    const p = plan(app, "Verify Alpha Top");
    assert.deepEqual(p.prerequisiteOrder, ["Zeta Base", "Alpha Top"]);
    assert.deepEqual(ids(p), ["zeta.one", "alpha.one"], "Zeta Base first although Alpha Top sorts first alphabetically");
  });
});

test("a named feature with no checks at all blocks the plan; an impacted feature with none is listed, not silently dropped", () => {
  withApp((app) => {
    app.knowledge.ensureFeature("Invoices", "d");
    const none = plan(app, "Test Invoices");
    assert.equal(none.status, "blocked");
    assert.ok(none.blockers.some((b) => b.kind === "no_cases" && b.feature === "Invoices"));
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    approveEdge(app.knowledge, "AFFECTS", "Contacts", "Invoices");
    const impacted = plan(app, "Test Contacts");
    assert.equal(impacted.status, "ready");
    assert.deepEqual(impacted.uncoveredFeatures, ["Invoices"]);
  });
});

test("a dependency cycle blocks the plan", () => {
  withApp((app) => {
    addCases(app.testbook, "A Feature", ["a.one"]);
    addCases(app.testbook, "B Feature", ["b.one"]);
    approveEdge(app.knowledge, "DEPENDS_ON", "A Feature", "B Feature");
    approveEdge(app.knowledge, "DEPENDS_ON", "B Feature", "A Feature");
    const p = plan(app, "Test A Feature");
    assert.equal(p.status, "blocked");
    assert.ok(p.blockers.some((b) => b.kind === "dependency_cycle"));
  });
});

test("nothing runnable blocks the plan even when the feature has checks", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.broken"], { quarantine: ["contacts.broken"] });
    const p = plan(app, "Test Contacts");
    assert.equal(p.status, "blocked");
    assert.deepEqual(p.blockers.map((b) => b.kind), ["nothing_runnable"]);
  });
});

test("only facts that apply in the context are used; scoped facts elsewhere are counted, not silently applied", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    const make = (semanticId, statement, scope) => app.knowledge.approveItem(app.knowledge.proposeItem({ semanticId, type: "BUSINESS_RULE", featureName: "Contacts", featureDescription: "d", title: semanticId, statement, provenance: "DOCUMENTED", source: { title: "s" }, scope }).id, HUMAN);
    make("BR-ALL-RULE-001", "Applies everywhere.", null);
    make("BR-LAWCUS-RULE-001", "Applies on the lawcus environment.", { environments: ["lawcus"] });
    make("BR-ADMIN-RULE-001", "Applies to admins only.", { roles: ["admin"] });
    const p = plan(app, "Test Contacts");
    assert.deepEqual(p.knowledgeItems.map((i) => i.semantic_id).sort(), ["BR-ALL-RULE-001", "BR-LAWCUS-RULE-001"]);
    assert.equal(p.outOfScopeFacts, 1);
    const admin = plan(app, "Test Contacts", { context: { environments: ["lawcus"], roles: ["admin"] } });
    assert.equal(admin.knowledgeItems.length, 3);
  });
});

// ---------- safety and honesty ----------

test("destructive requests and requests that do not ask for a test are never planned; an unknown feature is a review request", () => {
  withApp((app) => {
    addCases(app.testbook, "Contacts", ["contacts.a"]);
    for (const intent of ["Delete all contacts and test Contacts", "Test and then remove every Contacts record", "Verify Contacts then merge duplicates", "purge Contacts", "Test Contacts in bulk"]) {
      const p = plan(app, intent);
      assert.equal(p.matched, false, intent);
      assert.equal(p.reviewRequests[0].severity, "refused", intent);
      assert.deepEqual(p.cells, []);
    }
    for (const intent of ["Contacts", "Please look at Contacts", "create a matter for Contacts"]) {
      const p = plan(app, intent);
      assert.equal(p.matched, false, intent);
      assert.equal(p.reviewRequests[0].kind, "not_a_testing_request");
    }
    const unknown = plan(app, "Test Widgets");
    assert.equal(unknown.matched, false);
    assert.equal(unknown.reviewRequests[0].kind, "unknown_feature");
    assert.match(unknown.reviewRequests[0].message, /Known features: Contacts\./);
    assert.equal(plan(app, "").matched, false);
    assert.equal(plan(app, undefined).matched, false);
  });
});

// ---------- integration with the existing planner ----------

test("planImpactedTest keeps its hand-written patterns first, and falls back to the graph for anything else", () => {
  withApp((app) => {
    seedLawcusNativeCases(app.testbook);
    const known = planImpactedTest({ intent: "Update a contact custom field and check how it appears for existing/new Contact and Lead.", knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(known.patternId, "contact_custom_field_impacted");
    const viaGraph = planImpactedTest({ intent: "Verify Leads", knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(viaGraph.origin, "graph");
    assert.equal(viaGraph.matched, true);
    assert.ok(viaGraph.cells.some((c) => c.externalId.startsWith("leads.")));
    const refused = planImpactedTest({ intent: "Delete every matter", knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(refused.matched, false);
    assert.ok(Array.isArray(refused.reviewRequests));
    const unknown = planImpactedTest({ intent: "Test Widgets", knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(unknown.matched, false);
    assert.equal(unknown.reviewRequests[0].kind, "unknown_feature");
  });
});

test("a graph plan's cells run through the existing executor; blocked cells are recorded as not run", async () => {
  await withApp(async (app) => {
    addCases(app.testbook, "Contacts", ["contacts.a", "contacts.broken"], { quarantine: ["contacts.broken"] });
    const p = plan(app, "Test Contacts");
    const runbookId = randomUUID();
    app.db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString());
    const runId = randomUUID();
    app.db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "running", 0, new Date().toISOString());
    const results = await executeImpactedTest({ plan: p, db: app.db, runId, testbook: app.testbook, delayBetweenRunsMs: 0, runners: { "contacts.a": async () => ({ passed: true, actual: "ok" }) } });
    assert.deepEqual(results.map((r) => [r.externalId, r.executed]), [["contacts.a", true], ["contacts.broken", false]]);
  });
});

test("the run route refuses a blocked plan, and the seed proposes Matters DEPENDS_ON Contacts for review without approving it", () => {
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(index, /if \(!plan\.matched \|\| plan\.status === "blocked"\) \{ json\(res, 200, \{ plan, results: \[\], filedProposals: \[\] \}\); return; \}/);
  withApp((app) => {
    app.testbook.syncCases({ featureName: "Authentication", featureDescription: "d", suiteName: "login-essentials", suiteDescription: "d", priority: "normal", entries: loginTestCases });
    seedLawcusNativeCases(app.testbook);
    seedLawcusKnowledge(app.knowledge);
    assert.deepEqual(app.knowledge.approvedGraph(), [], "nothing is approved by seeding");
    const pending = app.knowledge.inboxEdges().map((e) => `${e.from_feature} ${e.type} ${e.to_feature}`);
    assert.ok(pending.includes("Matters DEPENDS_ON Contacts"), pending.join(" | "));
    // With nothing approved, a Matters request plans Matters alone and asks for the relation to be reviewed.
    const p = planFromKnowledge({ intent: "Verify Matters", knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(p.status, "ready");
    assert.ok(p.reviewRequests.some((r) => r.kind === "pending_edge" && /Matters DEPENDS_ON Contacts/.test(r.message)));
  });
});
