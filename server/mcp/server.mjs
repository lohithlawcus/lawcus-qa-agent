import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openProposals } from "../core/proposals.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { openResourceOwnership } from "../core/resource-ownership.mjs";
import { openResourceLocks } from "../core/resource-locks.mjs";
import { createCleanupRunner } from "../core/cleanup.mjs";
import { PROTECTED_RESOURCE_IDS } from "../testbook/lawcus-native-cases.mjs";
import * as tools from "./tools.mjs";
import { textResult, errorResult } from "./results.mjs";

// V5 Step 18 / master spec section 41 — Safe Lawcus QA MCP entrypoint.
// A genuinely separate process from server/index.mjs (the real "Core"),
// opening the exact same on-disk store (work/runtime/qa.sqlite, WAL mode,
// safe for concurrent real processes — already proven throughout this
// project's own live-verification scripts). This file assumes Core
// (`npm run qa:service`) has been run at least once already to seed
// Knowledge/API Contracts/TestBook — it deliberately does not duplicate
// that seeding here, so there is exactly one place that logic lives.
//
// section 41: "MCP is an interface to Core. It is not the source of
// truth and not the security boundary." Every tool below is a thin
// wrapper around server/mcp/tools.mjs's already-reviewed functions — this
// file's only job is protocol wiring (Zod input schemas, error shaping),
// never new business logic.

const directory = resolve("work/runtime");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const { db, audit } = openStore(directory);
// Same directory server/index.mjs's Core process already writes real
// evidence into (join(directory,"artifacts")) — MCP-triggered native
// checks (run_approved_test/run_approved_suite) can now save a failure
// screenshot there too, so a check run from either surface gets the same
// diagnostic evidence, not just the one triggered from the app's own UI.
const artifactDirectory = resolve(directory, "artifacts");
mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
const resourceOwnership = openResourceOwnership(db, audit, { protectedResourceIds: PROTECTED_RESOURCE_IDS });
const mutationJournal = openMutationJournal(db, audit);
const ctx = {
  db,
  audit,
  artifactDirectory,
  resourceOwnership,
  cleanupRunner: createCleanupRunner({ resourceOwnership, mutationJournal, resourceLocks: openResourceLocks(db, audit) }),
  knowledge: openKnowledge(db, audit),
  testbook: openTestBook(db, audit),
  proposals: openProposals(db, audit),
  apiContracts: openApiContracts(db, audit),
  mutationJournal,
};

const server = new McpServer({ name: "lawcus-qa", version: "1.0.0" });

function register(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return textResult(await handler(ctx, args));
    } catch (error) {
      return errorResult(error);
    }
  });
}

register(
  "search_lawcus_knowledge",
  "Full-text search over APPROVED Lawcus product Knowledge (never pending_review or rejected items).",
  { query: z.string().min(2).describe("Text to search for in semantic_id, title, or statement.") },
  tools.searchLawcusKnowledge,
);
register(
  "get_feature_rules",
  "Every approved Knowledge item for one named feature.",
  { featureName: z.string().min(1) },
  tools.getFeatureRules,
);
register(
  "find_affected_features",
  "Traverses the APPROVED Impact Graph from one feature and returns every feature reached.",
  { featureName: z.string().min(1) },
  tools.findAffectedFeatures,
);
register(
  "find_relevant_test_suites",
  "Real TestBook suites (and their cases) registered under one feature.",
  { featureName: z.string().min(1) },
  tools.findRelevantTestSuites,
);
register(
  "read_test_case",
  "One TestBook case's current definition by its external_id.",
  { externalId: z.string().min(1) },
  tools.readTestCase,
);
register(
  "read_api_contract",
  "The current APPROVED version of one API contract by semantic_id (fails clearly if none is approved yet).",
  { semanticId: z.string().min(1) },
  tools.readApiContract,
);
register(
  "create_test_proposal",
  "Files a real, pending_review NEW_TEST proposal for a human to review in the app. Never self-approved.",
  { featureName: z.string().min(1), title: z.string().min(1), steps: z.array(z.string()).min(1) },
  tools.createTestProposal,
);
register(
  "create_failure_analysis_proposal",
  "Files a real, pending_review proposal analyzing one real failed scenario_results row. The hypothesis is an unverified guess attached to quoted real evidence — never presented as fact.",
  { scenarioResultId: z.string().min(1), hypothesis: z.string().min(1) },
  tools.createFailureAnalysisProposal,
);
register(
  "list_pending_proposals",
  "Every proposal currently awaiting human review.",
  {},
  tools.listPendingProposals,
);
register(
  "run_approved_test",
  "Runs exactly one already-approved, already-registered TestBook case for real against live Lawcus staging. Refuses anything not already approved.",
  { externalId: z.string().min(1) },
  tools.runApprovedTest,
);
register(
  "run_approved_suite",
  "Runs every case in one known TestBook suite for real against live Lawcus staging.",
  { suiteName: z.string().min(1) },
  tools.runApprovedSuite,
);
register(
  "get_run_status",
  "One run's current status and summary.",
  { runId: z.string().min(1) },
  tools.getRunStatus,
);
register(
  "get_run_results",
  "Every scenario_results row for one run.",
  { runId: z.string().min(1) },
  tools.getRunResults,
);
register(
  "get_failure_evidence_summary",
  "Textual evidence for one failed scenario_results row (status/expected/actual/artifact metadata) — never raw screenshot or trace bytes.",
  { scenarioResultId: z.string().min(1) },
  tools.getFailureEvidenceSummary,
);

const transport = new StdioServerTransport();
await server.connect(transport);
