import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openProposals } from "../core/proposals.mjs";
import {
  normalizeIntent,
  traverseImpactGraph,
  planImpactedTest,
  proposeGapCoverage,
  executeImpactedTest,
} from "../core/impacted-testing.mjs";

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-impacted-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({
      db,
      knowledge: openKnowledge(db, audit),
      testbook: openTestBook(db, audit),
      proposals: openProposals(db, audit),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FLAGSHIP_INTENT = "Update a contact custom field and check how it appears for existing/new Contact and Lead.";

function seedGraph(knowledge) {
  knowledge.ensureFeature("Contact Custom Fields", "d");
  knowledge.ensureFeature("Contacts", "d");
  knowledge.ensureFeature("Leads", "d");
  knowledge.ensureFeature("Billing", "d"); // unrelated — must never appear in traversal
  const e1 = knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Contacts", toFeatureName: "Contact Custom Fields", rationale: "r" });
  const e2 = knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Leads", toFeatureName: "Contact Custom Fields", rationale: "r" });
  knowledge.approveEdge(e1.id, "operator:test");
  knowledge.approveEdge(e2.id, "operator:test");
}

function seedFullCoverage(testbook) {
  testbook.syncCases({
    featureName: "Contacts", featureDescription: "d", suiteName: "contact-verification", suiteDescription: "d",
    entries: {
      "contacts.custom_field_update_existing": { source: "s1", definition: { id: "contacts.custom_field_update_existing", name: "n", layer: "both", risk: "normal", status: "approved" } },
      "contacts.create_new_verifies_custom_fields": { source: "s2", definition: { id: "contacts.create_new_verifies_custom_fields", name: "n", layer: "both", risk: "normal", status: "approved" } },
    },
  });
  testbook.syncCases({
    featureName: "Leads", featureDescription: "d", suiteName: "lead-verification", suiteDescription: "d",
    entries: {
      "leads.custom_field_update_existing": { source: "s3", definition: { id: "leads.custom_field_update_existing", name: "n", layer: "both", risk: "normal", status: "approved" } },
      "leads.create_new_verifies_custom_fields": { source: "s4", definition: { id: "leads.create_new_verifies_custom_fields", name: "n", layer: "both", risk: "normal", status: "approved" } },
    },
  });
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
    runbookId, 1, "lawcus", "t", "intent", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(
    runId, runbookId, "passed", 0, new Date().toISOString(),
  );
  return runId;
}

test("normalizeIntent collapses whitespace and trims", () => {
  assert.equal(normalizeIntent("  Update   a contact  custom field \n"), "Update a contact custom field");
});

test("traverseImpactGraph does a real BFS over approved edges only, treating them as undirected, and never loops on a cycle", () => {
  const edges = [
    { from_feature: "A", to_feature: "B" },
    { from_feature: "C", to_feature: "B" }, // reverse direction — must still be found from B
    { from_feature: "B", to_feature: "D" },
    { from_feature: "D", to_feature: "A" }, // cycle back to the start
  ];
  const reached = traverseImpactGraph(edges, "A", 5);
  assert.deepEqual([...reached].sort(), ["A", "B", "C", "D"]);
});

test("traverseImpactGraph respects maxHops", () => {
  const edges = [
    { from_feature: "A", to_feature: "B" },
    { from_feature: "B", to_feature: "C" },
    { from_feature: "C", to_feature: "D" },
  ];
  assert.deepEqual(traverseImpactGraph(edges, "A", 1), ["A", "B"]);
  assert.deepEqual(traverseImpactGraph(edges, "A", 2), ["A", "B", "C"]);
});

test("planImpactedTest reports matched:false for an unrecognized prompt, without touching the graph or TestBook", () => {
  withApp(({ knowledge, testbook }) => {
    const plan = planImpactedTest({ intent: "Please reboot the mainframe.", knowledge, testbook });
    assert.equal(plan.matched, false);
    assert.deepEqual(plan.features, []);
    assert.deepEqual(plan.cells, []);
  });
});

test("planImpactedTest recognizes the master spec's flagship prompt, traverses only approved edges, and reports every cell as a gap when TestBook has no coverage yet", () => {
  withApp(({ knowledge, testbook }) => {
    seedGraph(knowledge);
    const plan = planImpactedTest({ intent: FLAGSHIP_INTENT, knowledge, testbook });
    assert.equal(plan.matched, true);
    assert.deepEqual([...plan.features].sort(), ["Contact Custom Fields", "Contacts", "Leads"]);
    assert.equal(plan.features.includes("Billing"), false); // unrelated feature never reached
    assert.equal(plan.cells.length, 4);
    assert.equal(plan.gaps.length, 4);
    assert.ok(plan.cells.every((c) => c.covered === false));
  });
});

test("planImpactedTest reports full coverage (zero gaps) once every cell's TestBook case is approved", () => {
  withApp(({ knowledge, testbook }) => {
    seedGraph(knowledge);
    seedFullCoverage(testbook);
    const plan = planImpactedTest({ intent: FLAGSHIP_INTENT, knowledge, testbook });
    assert.equal(plan.gaps.length, 0);
    assert.ok(plan.cells.every((c) => c.covered === true && c.testCaseId));
  });
});

test("planImpactedTest treats an unapproved (pending_review) case as a gap, not coverage", () => {
  withApp(({ knowledge, testbook }) => {
    seedGraph(knowledge);
    testbook.syncCases({
      featureName: "Contacts", featureDescription: "d", suiteName: "contact-verification", suiteDescription: "d",
      entries: {
        "contacts.custom_field_update_existing": { source: "s1", definition: { id: "contacts.custom_field_update_existing", name: "n", layer: "both", risk: "normal", status: "pending_review" } },
      },
    });
    const plan = planImpactedTest({ intent: FLAGSHIP_INTENT, knowledge, testbook });
    const cell = plan.cells.find((c) => c.externalId === "contacts.custom_field_update_existing");
    assert.equal(cell.covered, false);
    assert.equal(plan.gaps.includes(cell), true);
  });
});

test("proposeGapCoverage files one real NEW_TEST proposal per gap, pending_review, never self-approved", () => {
  withApp(({ knowledge, testbook, proposals }) => {
    seedGraph(knowledge);
    const plan = planImpactedTest({ intent: FLAGSHIP_INTENT, knowledge, testbook });
    const filed = proposeGapCoverage({ proposals, plan });
    assert.equal(filed.length, 4);
    assert.ok(filed.every((p) => p.status === "pending_review"));
    assert.ok(filed.every((p) => p.type === "NEW_TEST"));
    const inbox = proposals.inbox();
    assert.equal(inbox.length, 4);
  });
});

test("executeImpactedTest runs only covered cells for real, records scenario_results linked to the exact TestBook case/version, and never executes a gap", () => {
  return withApp(({ knowledge, testbook, db }) => {
    seedGraph(knowledge);
    seedFullCoverage(testbook);
    const plan = planImpactedTest({ intent: FLAGSHIP_INTENT, knowledge, testbook });
    const runId = seedRun(db);
    let calls = 0;
    const runners = {
      "contacts.custom_field_update_existing": async () => { calls++; return { passed: true, actual: "ok" }; },
      "contacts.create_new_verifies_custom_fields": async () => { calls++; return { passed: false, actual: "mismatch" }; },
      "leads.custom_field_update_existing": async () => { calls++; throw new Error("boom"); },
      "leads.create_new_verifies_custom_fields": async () => { calls++; return { passed: true, actual: "ok" }; },
    };
    return executeImpactedTest({ plan, runners, db, runId, testbook }).then((results) => {
      assert.equal(calls, 4);
      const byId = Object.fromEntries(results.map((r) => [r.externalId, r]));
      assert.equal(byId["contacts.custom_field_update_existing"].status, "passed");
      assert.equal(byId["contacts.create_new_verifies_custom_fields"].status, "failed");
      assert.match(byId["leads.custom_field_update_existing"].actual, /boom/);
      assert.equal(byId["leads.custom_field_update_existing"].status, "failed");
      assert.equal(byId["leads.create_new_verifies_custom_fields"].status, "passed");

      const rows = db.prepare("SELECT scenario,status,test_case_id,test_definition_version_id FROM scenario_results WHERE run_id=?").all(runId);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => r.test_case_id && r.test_definition_version_id));
    });
  });
});

test("executeImpactedTest skips gap cells entirely (never runs unapproved coverage) and writes no scenario_results row for them", () => {
  return withApp(({ knowledge, testbook, db }) => {
    seedGraph(knowledge);
    const plan = planImpactedTest({ intent: FLAGSHIP_INTENT, knowledge, testbook }); // zero coverage
    const runId = seedRun(db);
    return executeImpactedTest({ plan, runners: {}, db, runId, testbook }).then((results) => {
      assert.ok(results.every((r) => r.executed === false));
      const rows = db.prepare("SELECT count(*) n FROM scenario_results WHERE run_id=?").get(runId);
      assert.equal(rows.n, 0);
    });
  });
});
