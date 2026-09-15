import { randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";
import { ApiContractError } from "../core/api-contracts.mjs";
import { traverseImpactGraph, executeImpactedTest, proposeGapCoverage, planImpactedTest } from "../core/impacted-testing.mjs";
import { buildNativeRunners, NATIVE_SUITE_MEMBERS } from "../testbook/lawcus-native-cases.mjs";

// V5 Step 18 / master spec section 41 — Safe Lawcus QA MCP. Every function
// here is a thin, pure(ish) wrapper around a Core capability that already
// existed and was already reviewed before this step — nothing here
// invents new business logic, and nothing here is the tool list's own
// "Never expose" set (approve_own_proposal, promote_unapproved_test,
// execute_arbitrary_javascript, execute_unknown_primitive,
// change_expected_behavior_silently, change_api_contract_silently,
// enable_production, expand_network_authority_without_review,
// read_raw_secrets — none of those has a function here at all, not even
// a disabled one). "MCP is an interface to Core. It is not the source of
// truth and not the security boundary" — every write path below still
// goes through the exact same pending_review/human-approval gates as the
// web UI; this module adds no new authority.
//
// Deliberately not part of ctx: keychain/readSecret, any Playwright
// browser handle outside a native runner's own real login flow, and any
// eval/exec primitive. A tool that needed one of those would be exactly
// the "become the engine" anti-pattern section 60 warns against.

export const MCP_ERROR = {
  NOT_FOUND: "not_found",
  NOT_APPROVED: "not_approved",
  NOT_RUNNABLE: "not_runnable",
  ALREADY_RUNNING: "already_running",
  INVALID_INPUT: "invalid_input",
};

export class McpToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function searchLawcusKnowledge({ knowledge }, { query }) {
  if (!query || typeof query !== "string" || query.trim().length < 2)
    throw new McpToolError(MCP_ERROR.INVALID_INPUT, "query must be a string of at least 2 characters.");
  return knowledge.searchApproved(query.trim());
}

export function getFeatureRules({ knowledge }, { featureName }) {
  const group = knowledge.approvedByFeature().find((g) => g.feature === featureName);
  return group?.items ?? [];
}

export function findAffectedFeatures({ knowledge }, { featureName }) {
  return traverseImpactGraph(knowledge.approvedGraph(), featureName);
}

export function findRelevantTestSuites({ testbook }, { featureName }) {
  const feature = testbook.tree().find((f) => f.name === featureName);
  return feature?.suites ?? [];
}

export function readTestCase({ testbook }, { externalId }) {
  const testCase = testbook.findCase(externalId);
  if (!testCase) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No TestBook case with external_id "${externalId}".`);
  return testCase;
}

export function readApiContract({ apiContracts }, { semanticId }) {
  try {
    return apiContracts.resolveApprovedContract(semanticId);
  } catch (error) {
    if (error instanceof ApiContractError) throw new McpToolError(MCP_ERROR.NOT_APPROVED, error.message);
    throw error;
  }
}

/** section 41's create_test_proposal — an ordinary NEW_TEST proposal,
 * generatedBy 'mcp_tool' so it can never itself act as an approver
 * (proposals.mjs's NON_HUMAN_ORIGINS). Lands pending_review like every
 * other proposal; a human still has to review it in the app. */
export function createTestProposal({ proposals }, { featureName, title, steps }) {
  if (!featureName || !title || !Array.isArray(steps) || !steps.length)
    throw new McpToolError(MCP_ERROR.INVALID_INPUT, "featureName, title, and a non-empty steps array are required.");
  const id = proposals.create({
    type: "NEW_TEST",
    summary: `MCP-proposed test: "${title}" (${featureName}).`,
    trigger: "mcp_tool.create_test_proposal",
    subjectKind: "test_case",
    subjectId: `mcp.${featureName}.${title.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    proposedValue: JSON.stringify({ feature: featureName, name: title, steps }),
    risk: "medium",
    requiredApproverRole: "engineering",
    generatedBy: "mcp_tool",
  });
  return proposals.get(id);
}

/** section 41's create_failure_analysis_proposal. Scoped onto the
 * existing TEST_CHANGE proposal type (the closest real fit — evidence
 * that a test's expected behavior/environment assumptions may need
 * review) rather than inventing a new PROPOSAL_TYPES value; see
 * server/core/impacted-testing.mjs's file comment for the same kind of
 * scoping decision on create_test_proposal's sibling. The hypothesis is
 * exactly what it says — an unverified guess attached to real, quoted
 * evidence (the actual scenario_results row), never presented as fact:
 * this is a proposal, reviewed like any other. */
export function createFailureAnalysisProposal({ db, proposals }, { scenarioResultId, hypothesis }) {
  if (!scenarioResultId || !hypothesis)
    throw new McpToolError(MCP_ERROR.INVALID_INPUT, "scenarioResultId and hypothesis are required.");
  const row = db.prepare("SELECT * FROM scenario_results WHERE id=?").get(scenarioResultId);
  if (!row) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No scenario_results row with id "${scenarioResultId}".`);
  if (row.status !== "failed")
    throw new McpToolError(MCP_ERROR.INVALID_INPUT, `scenario_results "${scenarioResultId}" is not failed (status: ${row.status}) — nothing to analyze.`);
  const id = proposals.create({
    type: "TEST_CHANGE",
    summary: `MCP failure analysis for "${row.scenario}": ${hypothesis.slice(0, 200)}`,
    trigger: `mcp_tool.create_failure_analysis_proposal for scenario_results ${scenarioResultId}`,
    subjectKind: "test_case",
    subjectId: row.scenario,
    proposedValue: JSON.stringify({ scenarioResultId, scenario: row.scenario, expected: row.expected, actual: row.actual, hypothesis }),
    risk: "low",
    requiredApproverRole: "engineering",
    generatedBy: "mcp_tool",
  });
  return proposals.get(id);
}

export function listPendingProposals({ proposals }) {
  return proposals.inbox("pending_review");
}

function ensureNoActiveRun(db) {
  if (db.prepare("SELECT 1 FROM runs WHERE status='running'").get())
    throw new McpToolError(MCP_ERROR.ALREADY_RUNNING, "A test is already running. Wait for it to finish before starting another.");
}

/** Creates a real runbook+run row for an MCP-triggered execution — same
 * shape server/index.mjs's /impacted-tests/run route creates, just with
 * source 'mcp_tool' instead of 'impacted-testing' so it's honestly
 * distinguishable in history. */
function createMcpRun(db, { title, intent, externalIds }) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
    runbookId, 1, "lawcus", title, intent, "mcp_tool",
    JSON.stringify({ scenarios: externalIds }), now(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "running", 0, now());
  return runId;
}

function finishMcpRun(db, runId, results) {
  const anyFailed = results.some((r) => r.executed && r.status === "failed");
  db.prepare("UPDATE runs SET status=?,finished_at=?,summary=? WHERE id=?").run(
    anyFailed ? "failed" : "passed", now(),
    `${results.filter((r) => r.executed).length} case(s) executed via MCP.`,
    runId,
  );
}

/** section 41's run_approved_test — exactly one already-registered native
 * TestBook case, real browser automation against real staging (not a
 * simulation). Refuses anything not already an approved case; never runs
 * an "unknown primitive" (this is exactly what execute_unknown_primitive
 * in the Never-expose list would be, so there is no path to it here). */
export async function runApprovedTest({ db, testbook, apiContracts, mutationJournal }, { externalId }) {
  const testCase = testbook.findCase(externalId);
  if (!testCase) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No TestBook case with external_id "${externalId}".`);
  if (testCase.status !== "approved")
    throw new McpToolError(MCP_ERROR.NOT_APPROVED, `Case "${externalId}" is not approved (status: ${testCase.status}).`);
  const runners = buildNativeRunners({ apiContracts, mutationJournal, runId: null });
  if (!runners[externalId])
    throw new McpToolError(MCP_ERROR.NOT_RUNNABLE, `"${externalId}" is not individually runnable via MCP yet (only Step 15's native Contact/Lead cases are) — try run_approved_suite for a DSL-defined suite like login-essentials instead.`);
  ensureNoActiveRun(db);
  const runId = createMcpRun(db, { title: `MCP: ${externalId}`, intent: `run_approved_test(${externalId})`, externalIds: [externalId] });
  // Re-bind now that the real runId exists, since mutation-journal entries
  // must reference it.
  const boundRunners = buildNativeRunners({ apiContracts, mutationJournal, runId });
  const plan = { cells: [{ featureName: testCase.featureName, recordState: "n/a", externalId, covered: true }] };
  let results;
  try {
    results = await executeImpactedTest({ plan, runners: boundRunners, db, runId, testbook, delayBetweenRunsMs: 0 });
  } finally {
    finishMcpRun(db, runId, results ?? []);
  }
  return { runId, results };
}

/** section 41's run_approved_suite — every native case in a known suite
 * (server/testbook/lawcus-native-cases.mjs's NATIVE_SUITE_MEMBERS), or the
 * standard fixed login-essentials plan for that one DSL suite. */
export async function runApprovedSuite({ db, testbook, apiContracts, mutationJournal }, { suiteName }) {
  const members = NATIVE_SUITE_MEMBERS[suiteName];
  if (!members)
    throw new McpToolError(MCP_ERROR.NOT_RUNNABLE, `"${suiteName}" is not a suite this MCP server can run yet. Known suites: ${Object.keys(NATIVE_SUITE_MEMBERS).join(", ")}.`);
  ensureNoActiveRun(db);
  const runId = createMcpRun(db, { title: `MCP suite: ${suiteName}`, intent: `run_approved_suite(${suiteName})`, externalIds: members });
  const runners = buildNativeRunners({ apiContracts, mutationJournal, runId });
  const plan = { cells: members.map((externalId) => {
    const testCase = testbook.findCase(externalId);
    return { featureName: testCase?.featureName ?? suiteName, recordState: "n/a", externalId, covered: testCase?.status === "approved" };
  }) };
  let results;
  try {
    results = await executeImpactedTest({ plan, runners, db, runId, testbook, delayBetweenRunsMs: 8000 });
  } finally {
    finishMcpRun(db, runId, results ?? []);
  }
  return { runId, results };
}

export function getRunStatus({ db }, { runId }) {
  const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
  if (!run) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No run with id "${runId}".`);
  return run;
}

export function getRunResults({ db }, { runId }) {
  const run = db.prepare("SELECT 1 FROM runs WHERE id=?").get(runId);
  if (!run) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No run with id "${runId}".`);
  return db.prepare("SELECT * FROM scenario_results WHERE run_id=? ORDER BY id").all(runId);
}

/** section 41's get_failure_evidence_summary — textual evidence only
 * (status/expected/actual/artifact kind+name). Deliberately never
 * decrypts or returns raw screenshot/trace bytes through this path —
 * that would be a broader exposure than the "safe examples" list implies,
 * and nothing in section 41 asks for it. */
export function getFailureEvidenceSummary({ db }, { scenarioResultId }) {
  const row = db.prepare("SELECT * FROM scenario_results WHERE id=?").get(scenarioResultId);
  if (!row) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No scenario_results row with id "${scenarioResultId}".`);
  const artifacts = db.prepare("SELECT kind, filename FROM artifacts WHERE scenario_result_id=?").all(scenarioResultId);
  return {
    scenarioResultId,
    scenario: row.scenario,
    status: row.status,
    expected: row.expected,
    actual: row.actual,
    durationMs: row.duration_ms,
    artifacts,
  };
}

// Re-exported so an MCP-hosted client could also plan (not execute) an
// impacted test the same way the web UI's "Check coverage" button does —
// pure and side-effect-free, no reason to duplicate it under a new name.
export { planImpactedTest, proposeGapCoverage };
