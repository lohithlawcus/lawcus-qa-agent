import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, now } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openProposals } from "../core/proposals.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import {
  McpToolError,
  MCP_ERROR,
  searchLawcusKnowledge,
  getFeatureRules,
  findAffectedFeatures,
  findRelevantTestSuites,
  readTestCase,
  readApiContract,
  createTestProposal,
  createFailureAnalysisProposal,
  listPendingProposals,
  runApprovedTest,
  runApprovedSuite,
  getRunStatus,
  getRunResults,
  getFailureEvidenceSummary,
} from "../mcp/tools.mjs";

function withCtx(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-mcp-tools-"));
  try {
    const { db, audit } = openStore(dir);
    const ctx = {
      db,
      knowledge: openKnowledge(db, audit),
      testbook: openTestBook(db, audit),
      proposals: openProposals(db, audit),
      apiContracts: openApiContracts(db, audit),
      mutationJournal: openMutationJournal(db, audit),
    };
    return fn(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedApprovedKnowledge(knowledge) {
  const item = knowledge.proposeItem({
    semanticId: "BR-CF-RENAME-001",
    type: "BUSINESS_RULE",
    featureName: "Contact Custom Fields",
    featureDescription: "d",
    title: "Renaming a custom field preserves existing values",
    statement: "Renaming a Contact custom field updates the displayed name on existing records without touching the stored value.",
    provenance: "DOCUMENTED",
  });
  knowledge.approveItem(item.id, "operator:test");
  return item;
}

function seedGraph(knowledge) {
  knowledge.ensureFeature("Contact Custom Fields", "d");
  knowledge.ensureFeature("Contacts", "d");
  const edge = knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Contacts", toFeatureName: "Contact Custom Fields", rationale: "r" });
  knowledge.approveEdge(edge.id, "operator:test");
}

function seedNativeCase(testbook, { status = "approved" } = {}) {
  testbook.syncCases({
    featureName: "Contacts", featureDescription: "d", suiteName: "contact-verification", suiteDescription: "d",
    entries: {
      "contacts.custom_field_update_existing": { source: JSON.stringify({ kind: "native", module: "m", function: "runContactCustomFieldCheck" }), definition: { id: "contacts.custom_field_update_existing", name: "Update existing", layer: "both", risk: "normal", status } },
    },
  });
}

function seedRunAndScenarioResult(db, { status = "failed" } = {}) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "intent", "built-in", JSON.stringify({ scenarios: [] }), now());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "passed", 0, now());
  const scenarioResultId = randomUUID();
  db.prepare(
    "INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,healed) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(scenarioResultId, runId, "contacts.custom_field_update_existing", "t", status, "should pass", "it failed", 100, 0);
  return { runId, scenarioResultId };
}

test("searchLawcusKnowledge finds approved items by text, and only approved ones", () => {
  withCtx(({ knowledge }) => {
    const item = seedApprovedKnowledge(knowledge);
    const pendingOnly = knowledge.proposeItem({
      semanticId: "BR-CF-OTHER-001", type: "BUSINESS_RULE", featureName: "Contact Custom Fields", featureDescription: "d",
      title: "Some other unapproved rule about renaming", statement: "Some other statement about renaming fields.", provenance: "DOCUMENTED",
    });
    const results = searchLawcusKnowledge({ knowledge }, { query: "renam" });
    assert.ok(results.some((r) => r.id === item.id));
    assert.ok(!results.some((r) => r.id === pendingOnly.id), "must never surface a pending_review item as if trusted");
  });
});

test("searchLawcusKnowledge rejects a too-short or missing query", () => {
  withCtx(({ knowledge }) => {
    assert.throws(() => searchLawcusKnowledge({ knowledge }, { query: "a" }), McpToolError);
    assert.throws(() => searchLawcusKnowledge({ knowledge }, {}), McpToolError);
  });
});

test("getFeatureRules returns only approved items for the named feature, empty for an unknown one", () => {
  withCtx(({ knowledge }) => {
    seedApprovedKnowledge(knowledge);
    assert.equal(getFeatureRules({ knowledge }, { featureName: "Contact Custom Fields" }).length, 1);
    assert.deepEqual(getFeatureRules({ knowledge }, { featureName: "Nonexistent Feature" }), []);
  });
});

test("findAffectedFeatures traverses only the approved Impact Graph", () => {
  withCtx(({ knowledge }) => {
    seedGraph(knowledge);
    const reached = findAffectedFeatures({ knowledge }, { featureName: "Contact Custom Fields" });
    assert.ok(reached.includes("Contacts"));
  });
});

test("findRelevantTestSuites returns real TestBook suites for a feature", () => {
  withCtx(({ testbook }) => {
    seedNativeCase(testbook);
    const suites = findRelevantTestSuites({ testbook }, { featureName: "Contacts" });
    assert.equal(suites.length, 1);
    assert.equal(suites[0].name, "contact-verification");
  });
});

test("readTestCase returns a real case's current definition, or throws not_found", () => {
  withCtx(({ testbook }) => {
    seedNativeCase(testbook);
    const found = readTestCase({ testbook }, { externalId: "contacts.custom_field_update_existing" });
    assert.equal(found.status, "approved");
    assert.match(found.source, /runContactCustomFieldCheck/);
    assert.throws(() => readTestCase({ testbook }, { externalId: "does.not.exist" }), (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_FOUND);
  });
});

test("readApiContract returns the approved contract, or a clear not_approved error rather than crashing", () => {
  withCtx(({ apiContracts }) => {
    const proposed = apiContracts.proposeContract({
      semanticId: "lawcus.test.read", featureName: "Test", featureDescription: "d", operation: "op",
      method: "GET", pathTemplate: "/test", responseSchema: { "200": { type: "object" } },
      expectedStatuses: [200], readWrite: "read", verificationRequirements: "r", provenance: "OBSERVED_API",
    });
    assert.throws(
      () => readApiContract({ apiContracts }, { semanticId: "lawcus.test.read" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_APPROVED,
    );
    apiContracts.approveContract(proposed.id, "operator:test");
    const approved = readApiContract({ apiContracts }, { semanticId: "lawcus.test.read" });
    assert.equal(approved.semantic_id, "lawcus.test.read");
  });
});

test("createTestProposal files a real pending_review NEW_TEST proposal with generatedBy mcp_tool", () => {
  withCtx(({ proposals }) => {
    const created = createTestProposal({ proposals }, { featureName: "Contacts", title: "A new check", steps: ["do something"] });
    assert.equal(created.status, "pending_review");
    assert.equal(created.type, "NEW_TEST");
    assert.equal(created.generated_by, "mcp_tool");
  });
});

test("createTestProposal validates required fields", () => {
  withCtx(({ proposals }) => {
    assert.throws(() => createTestProposal({ proposals }, { featureName: "Contacts", title: "x", steps: [] }), McpToolError);
    assert.throws(() => createTestProposal({ proposals }, { title: "x", steps: ["a"] }), McpToolError);
  });
});

test("createFailureAnalysisProposal reads a real failed scenario_results row and files a real TEST_CHANGE proposal quoting it", () => {
  withCtx(({ db, proposals }) => {
    const { scenarioResultId } = seedRunAndScenarioResult(db, { status: "failed" });
    const created = createFailureAnalysisProposal({ db, proposals }, { scenarioResultId, hypothesis: "Likely a real staging timing issue." });
    assert.equal(created.type, "TEST_CHANGE");
    assert.equal(created.status, "pending_review");
    assert.equal(created.generated_by, "mcp_tool");
    const value = JSON.parse(created.proposed_value);
    assert.equal(value.actual, "it failed");
    assert.equal(value.hypothesis, "Likely a real staging timing issue.");
  });
});

test("createFailureAnalysisProposal refuses a scenario_results row that isn't actually failed, and an unknown id", () => {
  withCtx(({ db, proposals }) => {
    const { scenarioResultId } = seedRunAndScenarioResult(db, { status: "passed" });
    assert.throws(
      () => createFailureAnalysisProposal({ db, proposals }, { scenarioResultId, hypothesis: "h" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.INVALID_INPUT,
    );
    assert.throws(
      () => createFailureAnalysisProposal({ db, proposals }, { scenarioResultId: randomUUID(), hypothesis: "h" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_FOUND,
    );
  });
});

test("listPendingProposals mirrors the real proposals inbox", () => {
  withCtx(({ proposals }) => {
    createTestProposal({ proposals }, { featureName: "Contacts", title: "A new check", steps: ["do something"] });
    assert.equal(listPendingProposals({ proposals }).length, 1);
  });
});

test("runApprovedTest refuses an unknown case and a pending_review case before touching any real browser code", () => {
  return withCtx(async ({ db, testbook, apiContracts, mutationJournal }) => {
    await assert.rejects(
      runApprovedTest({ db, testbook, apiContracts, mutationJournal }, { externalId: "does.not.exist" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_FOUND,
    );
    seedNativeCase(testbook, { status: "pending_review" });
    await assert.rejects(
      runApprovedTest({ db, testbook, apiContracts, mutationJournal }, { externalId: "contacts.custom_field_update_existing" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_APPROVED,
    );
  });
});

test("runApprovedTest refuses to start while a run is already in progress", () => {
  return withCtx(async ({ db, testbook, apiContracts, mutationJournal }) => {
    seedNativeCase(testbook, { status: "approved" });
    const runbookId = randomUUID();
    db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ scenarios: [] }), now());
    db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(randomUUID(), runbookId, "running", 0, now());
    await assert.rejects(
      runApprovedTest({ db, testbook, apiContracts, mutationJournal }, { externalId: "contacts.custom_field_update_existing" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.ALREADY_RUNNING,
    );
  });
});

test("runApprovedSuite refuses an unknown suite name before touching any real browser code", () => {
  return withCtx(async ({ db, testbook, apiContracts, mutationJournal }) => {
    await assert.rejects(
      runApprovedSuite({ db, testbook, apiContracts, mutationJournal }, { suiteName: "not-a-real-suite" }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_RUNNABLE,
    );
  });
});

test("getRunStatus / getRunResults return real rows, or a clear not_found for an unknown run", () => {
  withCtx(({ db }) => {
    const { runId } = seedRunAndScenarioResult(db, { status: "passed" });
    const status = getRunStatus({ db }, { runId });
    assert.equal(status.id, runId);
    const results = getRunResults({ db }, { runId });
    assert.equal(results.length, 1);
    assert.throws(() => getRunStatus({ db }, { runId: randomUUID() }), (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_FOUND);
    assert.throws(() => getRunResults({ db }, { runId: randomUUID() }), (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_FOUND);
  });
});

test("getFailureEvidenceSummary returns textual evidence plus artifact metadata only — never raw bytes", () => {
  withCtx(({ db }) => {
    const { scenarioResultId } = seedRunAndScenarioResult(db, { status: "failed" });
    const summary = getFailureEvidenceSummary({ db }, { scenarioResultId });
    assert.equal(summary.status, "failed");
    assert.equal(summary.actual, "it failed");
    assert.deepEqual(summary.artifacts, []);
    assert.throws(() => getFailureEvidenceSummary({ db }, { scenarioResultId: randomUUID() }), (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_FOUND);
  });
});
