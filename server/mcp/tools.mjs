import { randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";
import { ApiContractError } from "../core/api-contracts.mjs";
import { executeImpactedTest, proposeGapCoverage, planImpactedTest } from "../core/impacted-testing.mjs";
import { impactedFeatures } from "../core/graph-planner.mjs";
import { KnowledgeError } from "../core/knowledge.mjs";
import { buildNativeRunners, NATIVE_SUITE_MEMBERS } from "../testbook/lawcus-native-cases.mjs";
import { finalizeRun } from "../core/run-outcome.mjs";
import { closeOutCleanup } from "../core/run-cleanup.mjs";
import { checkStagingBudget, stagingBusy } from "../core/run-admission.mjs";
import { currentCodeRevision } from "../core/code-revision.mjs";

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
  RATE_LIMITED: "rate_limited",
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

/** The features a CHANGE to `featureName` reaches through APPROVED edges,
 * following each edge type's direction (a dependency is not a two-way street).
 * The named feature comes first. */
export function findAffectedFeatures({ knowledge }, { featureName }) {
  return [featureName, ...impactedFeatures(knowledge.approvedGraph(), featureName).keys()];
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

// Same staging run budget the app enforces (server/core/run-admission.mjs),
// so a run started through MCP can't bypass the limit protecting the one
// shared QA account.
function ensureWithinRunBudget(db) {
  const budget = checkStagingBudget(db, "lawcus");
  if (!budget.ok)
    throw new McpToolError(MCP_ERROR.RATE_LIMITED, `${budget.recent} staging runs were started in the last ${budget.windowMinutes} minutes (limit ${budget.limit}). Wait before starting another.`);
}

function ensureNoActiveRun(db) {
  if (stagingBusy(db))
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
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at,code_revision) VALUES(?,?,?,?,?,?)").run(runId, runbookId, "running", 0, now(), currentCodeRevision());
  return runId;
}


/** section 41's run_approved_test — exactly one already-registered native
 * TestBook case, real browser automation against real staging (not a
 * simulation). Refuses anything not already an approved case; never runs
 * an "unknown primitive" (this is exactly what execute_unknown_primitive
 * in the Never-expose list would be, so there is no path to it here). */
export async function runApprovedTest({ db, testbook, apiContracts, mutationJournal, artifactDirectory, audit, resourceOwnership, cleanupRunner }, { externalId }) {
  const testCase = testbook.findCase(externalId);
  if (!testCase) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No TestBook case with external_id "${externalId}".`);
  if (testCase.status !== "approved")
    throw new McpToolError(MCP_ERROR.NOT_APPROVED, `Case "${externalId}" is not approved (status: ${testCase.status}).`);
  if (testCase.automationReadiness === "quarantined")
    throw new McpToolError(MCP_ERROR.NOT_RUNNABLE, `Case "${externalId}" is quarantined (its automation is known to be broken): ${testCase.quarantineReason}`);
  const runners = buildNativeRunners({ apiContracts, mutationJournal, runId: null });
  if (!runners[externalId])
    throw new McpToolError(MCP_ERROR.NOT_RUNNABLE, `"${externalId}" is not individually runnable via MCP yet (only Step 15's native Contact/Lead cases are) — try run_approved_suite for a DSL-defined suite like login-essentials instead.`);
  ensureNoActiveRun(db);
  ensureWithinRunBudget(db);
  const runId = createMcpRun(db, { title: `MCP: ${externalId}`, intent: `run_approved_test(${externalId})`, externalIds: [externalId] });
  // Re-bind now that the real runId exists, since mutation-journal entries
  // must reference it.
  const boundRunners = buildNativeRunners({ apiContracts, mutationJournal, runId, resourceOwnership });
  const plan = { cells: [{ featureName: testCase.featureName, recordState: "n/a", externalId, covered: true }] };
  let results;
  try {
    results = await executeImpactedTest({ plan, runners: boundRunners, db, runId, testbook, delayBetweenRunsMs: 0, artifactDirectory, audit });
  } catch (error) {
    // Never leave a default "passed" behind an exception.
    finalizeRun(db, runId, { planned: plan.cells.length, error });
    await closeOutCleanup({ db, cleanupRunner, runId, audit });
    throw error;
  }
  const verdict = finalizeRun(db, runId, { results });
  const cleanup = await closeOutCleanup({ db, cleanupRunner, runId, audit });
  return { runId, outcome: verdict.outcome, cleanup: cleanup?.overall ?? "unknown", leftovers: cleanup?.leftovers.length ?? null, results };
}

/** section 41's run_approved_suite — every native case in a known suite
 * (server/testbook/lawcus-native-cases.mjs's NATIVE_SUITE_MEMBERS), or the
 * standard fixed login-essentials plan for that one DSL suite. */
export async function runApprovedSuite({ db, testbook, apiContracts, mutationJournal, artifactDirectory, audit, resourceOwnership, cleanupRunner }, { suiteName }) {
  const members = NATIVE_SUITE_MEMBERS[suiteName];
  if (!members)
    throw new McpToolError(MCP_ERROR.NOT_RUNNABLE, `"${suiteName}" is not a suite this MCP server can run yet. Known suites: ${Object.keys(NATIVE_SUITE_MEMBERS).join(", ")}.`);
  ensureNoActiveRun(db);
  ensureWithinRunBudget(db);
  const runId = createMcpRun(db, { title: `MCP suite: ${suiteName}`, intent: `run_approved_suite(${suiteName})`, externalIds: members });
  const runners = buildNativeRunners({ apiContracts, mutationJournal, runId, resourceOwnership });
  const plan = { cells: members.map((externalId) => {
    const testCase = testbook.findCase(externalId);
    // Runnable = approved AND not quarantined. An unapproved, missing or
    // quarantined member is reported as not run, never silently counted.
    return {
      featureName: testCase?.featureName ?? suiteName, recordState: "n/a", externalId,
      covered: Boolean(testCase?.runnable),
      blockedReason: testCase?.runnable ? null : !testCase ? "no_case" : testCase.status !== "approved" ? "not_approved" : "quarantined",
    };
  }) };
  let results;
  try {
    results = await executeImpactedTest({ plan, runners, db, runId, testbook, delayBetweenRunsMs: 8000, artifactDirectory, audit });
  } catch (error) {
    finalizeRun(db, runId, { planned: plan.cells.length, error });
    await closeOutCleanup({ db, cleanupRunner, runId, audit });
    throw error;
  }
  const verdict = finalizeRun(db, runId, { results });
  const cleanup = await closeOutCleanup({ db, cleanupRunner, runId, audit });
  return { runId, outcome: verdict.outcome, cleanup: cleanup?.overall ?? "unknown", leftovers: cleanup?.leftovers.length ?? null, results };
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

// ---------- Knowledge review and the change loop ----------
//
// Everything below either READS, or files something PENDING for a person. The
// MCP identity ("mcp") is a non-human origin, so it cannot approve, flag,
// resolve or dismiss even if a future change tried to let it; none of those
// has a tool. A revision proposed here may claim only observed, inferred or
// assumed evidence, never documented or product-approved, so a reviewer is
// never told an AI's guess carries an owner's authority.

const MCP_ACTOR = "mcp";
export const MCP_REVISION_PROVENANCE = ["OBSERVED", "INFERRED", "ASSUMED"];
export const MCP_HOURLY_LIMIT = 30;
const TRUSTED_STATES = new Set(["current", "under_review", "stale"]);

/** Knowledge-layer errors become tool errors a caller can act on. */
function translate(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KnowledgeError)
      throw new McpToolError(error.code === "not_found" ? MCP_ERROR.NOT_FOUND : MCP_ERROR.INVALID_INPUT, error.message);
    throw error;
  }
}

function hourlyCount(db, sql) {
  return db.prepare(sql).get(new Date(Date.now() - 3600000).toISOString()).n;
}

export function listFacts({ factCards }, { status = null, feature = null, includeUnapproved = false } = {}) {
  const facts = factCards.listFacts({ status, feature });
  return includeUnapproved ? facts : facts.filter((fact) => TRUSTED_STATES.has(fact.derivedStatus));
}

export function getFact({ factCards }, { reference }) {
  const card = factCards.factCard(reference);
  if (!card) throw new McpToolError(MCP_ERROR.NOT_FOUND, `No Knowledge item matches "${reference}".`);
  const trusted = card.status === "approved";
  return {
    ...card,
    trusted,
    ...(trusted ? {} : { warning: `This fact is ${card.derivedStatus.replaceAll("_", " ")}, not approved. Do not treat it as a product rule.` }),
  };
}

export function listStaleFacts({ changeSignals }, { olderThanDays } = {}) {
  return changeSignals.staleFacts(olderThanDays ? { olderThanDays } : {});
}

/** Plans a test request from approved knowledge without running anything. */
export function planTestRequest({ knowledge, testbook }, { intent }) {
  if (typeof intent !== "string" || intent.trim().length < 3)
    throw new McpToolError(MCP_ERROR.INVALID_INPUT, "intent must be a sentence of at least 3 characters.");
  const plan = planImpactedTest({ intent, knowledge, testbook });
  return {
    matched: plan.matched,
    origin: plan.origin ?? (plan.matched ? "known_pattern" : "none"),
    status: plan.matched ? (plan.status ?? "ready") : "not_planned",
    subjectFeatureName: plan.subjectFeatureName ?? null,
    features: plan.features ?? [],
    cells: (plan.cells ?? []).map((cell) => ({
      externalId: cell.externalId, featureName: cell.featureName, covered: cell.covered, blockedReason: cell.blockedReason ?? null,
      role: cell.role ?? null, reasons: cell.reasons ?? [], prerequisites: cell.prerequisites ?? [],
    })),
    blockers: plan.blockers ?? [],
    reviewRequests: plan.reviewRequests ?? [],
    uncoveredFeatures: plan.uncoveredFeatures ?? [],
    factsUsed: (plan.knowledgeItems ?? []).map((item) => ({ semanticId: item.semantic_id, title: item.title })),
    flaggedFacts: (plan.reviewFlags ?? []).map((flag) => flag.semantic_id),
    note: "Planning only: nothing was run. A blocked plan lists what is missing. To run a listed check use run_approved_test.",
  };
}

export function listChangeSignals({ changeSignals }, { status = null } = {}) {
  return changeSignals.list({ status });
}

export function getChangeSignal({ changeSignals }, { signalId }) {
  return translate(() => changeSignals.get(signalId));
}

/** Records a change and analyzes it. Changes no fact, test or expectation. */
export function submitChangeSignal({ db, changeSignals }, input) {
  if (hourlyCount(db, "SELECT COUNT(*) n FROM change_signals WHERE submitted_by='mcp' AND received_at>?") >= MCP_HOURLY_LIMIT)
    throw new McpToolError(MCP_ERROR.RATE_LIMITED, `At most ${MCP_HOURLY_LIMIT} change signals may be submitted through MCP per hour.`);
  return translate(() => {
    const signal = changeSignals.submit({ ...input, submittedBy: MCP_ACTOR });
    return signal.duplicate ? signal : { ...changeSignals.analyze(signal.id), duplicate: false };
  });
}

/** Files a PENDING revision of an approved fact. A person still has to approve it. */
export function proposeFactRevision({ db, changeSignals }, { signalId, semanticId, statement, provenance = "INFERRED" }) {
  if (!MCP_REVISION_PROVENANCE.includes(provenance))
    throw new McpToolError(MCP_ERROR.INVALID_INPUT, `provenance must be one of ${MCP_REVISION_PROVENANCE.join(", ")}: only a person can claim a documented or product-approved source.`);
  if (hourlyCount(db, "SELECT COUNT(*) n FROM change_signal_items WHERE created_at>?") >= MCP_HOURLY_LIMIT)
    throw new McpToolError(MCP_ERROR.RATE_LIMITED, `At most ${MCP_HOURLY_LIMIT} fact revisions may be proposed per hour.`);
  return translate(() => ({ ...changeSignals.proposeRevision({ signalId, semanticId, statement, provenance, proposedBy: MCP_ACTOR }), status: "pending_review", note: "A person must approve this revision before it changes anything." }));
}

export { planImpactedTest, proposeGapCoverage };
