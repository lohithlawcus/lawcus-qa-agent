import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealEvidence } from "./setup.mjs";
import { takeEvidence } from "./evidence.mjs";
import { now } from "./store.mjs";

// V5 Step 16 — Natural-Language Impacted Testing (master spec Step 16;
// Knowledge Base guide section 42's identical flow):
//
//   local intent -> Impact Graph -> approved Knowledge -> existing
//   TestBook coverage -> gap detection -> optional NEW_TEST proposal ->
//   human review -> approved test execution
//
// Generalizes intent.mjs's login-only local router (that file's own
// comment already points here) to a second domain: Contact/Lead custom
// field verification, matching the master spec's own flagship example
// prompt almost verbatim. Everything here is deterministic — no AI call
// anywhere in this module. A prompt this project can't recognize locally
// simply reports matched:false; teaching it a new pattern is a human
// decision (adding an entry to KNOWN_IMPACT_PATTERNS), not something this
// module invents at runtime.

export function normalizeIntent(text) {
  return text.trim().replace(/\s+/g, " ");
}

// Matches the master spec's own Step 16 example verbatim, plus the
// obvious close variants (singular/plural "field(s)", "contact" case,
// optional trailing punctuation). Deliberately narrow — section 3.5
// ("Novelty is human-gated") applies here exactly as it does to locators:
// broadening this pattern is a reviewable code change, not a runtime
// guess.
const CONTACT_CUSTOM_FIELD_IMPACT_INTENT =
  /^update a contact custom fields?\s+and\s+check how it appears\s+for\s+existing\s*\/\s*new\s+contact and lead\.?$/i;

// One row per "cell" of section 50's existing/new x Contact/Lead matrix
// that this project can currently execute for real. Each externalId must
// be a real, registered TestBook case (server/testbook/lawcus-native-cases.mjs)
// — this list is the map from "what the prompt is asking about" to "what
// TestBook coverage would satisfy it", not itself a claim that coverage
// exists (that's checked live against the TestBook, never assumed).
const CONTACT_CUSTOM_FIELD_CELLS = [
  { featureName: "Contacts", recordState: "existing", externalId: "contacts.custom_field_update_existing" },
  { featureName: "Contacts", recordState: "new", externalId: "contacts.create_new_verifies_custom_fields" },
  { featureName: "Leads", recordState: "existing", externalId: "leads.custom_field_update_existing" },
  { featureName: "Leads", recordState: "new", externalId: "leads.create_new_verifies_custom_fields" },
];

const KNOWN_IMPACT_PATTERNS = [
  {
    id: "contact_custom_field_impacted",
    subjectFeatureName: "Contact Custom Fields",
    test: (normalized) => CONTACT_CUSTOM_FIELD_IMPACT_INTENT.test(normalized),
    cells: CONTACT_CUSTOM_FIELD_CELLS,
  },
];

/** Breadth-first traversal of the APPROVED behavior graph only (section 9:
 * "unapproved edges never alter a trusted impact calculation") starting
 * from one feature name, returning every feature reachable within maxHops
 * — cycles are handled by the visited-set, never infinite-looping. */
export function traverseImpactGraph(approvedEdges, startFeatureName, maxHops = 3) {
  const visited = new Set([startFeatureName]);
  let frontier = [startFeatureName];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    for (const name of frontier) {
      for (const edge of approvedEdges) {
        const neighbor =
          edge.from_feature === name ? edge.to_feature : edge.to_feature === name ? edge.from_feature : null;
        if (neighbor && !visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return [...visited];
}

/**
 * The deterministic core of Step 16: parses intent locally, traverses the
 * approved Impact Graph from the matched subject feature, retrieves
 * approved Knowledge for every reached feature, and checks each required
 * "cell" (feature x existing/new) against real TestBook coverage —
 * approved, non-deprecated cases only. Never calls AI. Returns enough
 * structure for a caller to either execute (all covered) or propose a
 * NEW_TEST for each gap.
 */
export function planImpactedTest({ intent, knowledge, testbook }) {
  const normalizedIntent = normalizeIntent(intent);
  const pattern = KNOWN_IMPACT_PATTERNS.find((p) => p.test(normalizedIntent));
  if (!pattern) {
    return { normalizedIntent, matched: false, features: [], knowledgeItems: [], cells: [], gaps: [] };
  }

  const approvedEdges = knowledge.approvedGraph();
  const features = traverseImpactGraph(approvedEdges, pattern.subjectFeatureName);

  const knowledgeItems = knowledge
    .approvedByFeature()
    .filter((group) => features.includes(group.feature))
    .flatMap((group) => group.items);

  const tree = testbook.tree();
  const cells = pattern.cells.map((cell) => {
    const feature = tree.find((f) => f.name === cell.featureName);
    const testCase = feature?.suites.flatMap((s) => s.cases).find((c) => c.externalId === cell.externalId);
    // Covered means approved AND its automation isn't quarantined — an
    // approved-but-known-broken case must never count as coverage.
    const covered = Boolean(testCase?.runnable);
    const blockedReason = covered
      ? null
      : !testCase
        ? "no_case"
        : testCase.status !== "approved"
          ? "not_approved"
          : "quarantined";
    return { ...cell, covered, blockedReason, testCaseId: testCase?.id ?? null, currentVersion: testCase?.currentVersion ?? null };
  });

  return {
    normalizedIntent,
    matched: true,
    patternId: pattern.id,
    subjectFeatureName: pattern.subjectFeatureName,
    features,
    knowledgeItems,
    cells,
    // A quarantined case exists and is approved — it is not a coverage
    // gap to propose new tests for, it is a known-broken check to repair.
    gaps: cells.filter((c) => !c.covered && c.blockedReason !== "quarantined"),
    quarantined: cells.filter((c) => c.blockedReason === "quarantined"),
  };
}

/** Files one real NEW_TEST proposal per gap cell (section 14's discipline
 * applies exactly as it does to every other proposal type — pending_review
 * only, never self-approved). generatedBy must be a non-human origin so
 * requireHumanApprover-style checks elsewhere continue to refuse it as an
 * approver identity. */
export function proposeGapCoverage({ proposals, plan, generatedBy = "impacted_testing" }) {
  return plan.gaps.map((gap) => {
    const id = proposals.create({
      type: "NEW_TEST",
      summary: `No approved TestBook coverage for ${gap.featureName} (${gap.recordState} record) under "${plan.normalizedIntent}".`,
      trigger: `impacted_testing plan for intent: "${plan.normalizedIntent}"`,
      subjectKind: "test_case",
      subjectId: gap.externalId,
      proposedValue: JSON.stringify({
        feature: gap.featureName,
        recordState: gap.recordState,
        externalId: gap.externalId,
        reason: "Impact-graph traversal found this cell relevant to the request, but no approved TestBook case exists for it yet.",
      }),
      risk: "medium",
      requiredApproverRole: "engineering",
      generatedBy,
    });
    return proposals.get(id);
  });
}

/**
 * Executes every covered cell for real via the given native-case runners
 * (server/core/live-runner.mjs's run*Check functions — real browser
 * automation against real staging, not a simulation), recording each
 * result to scenario_results linked to its exact TestBook case/version
 * (section 5/6 discipline) under one real run. Never executes a gap cell —
 * those only ever reach proposeGapCoverage.
 *
 * Each real cell is a full, fresh login against staging (server/core/
 * live-runner.mjs's run*Check helpers). Live testing on 2026-09-16 showed
 * several real staging logins fired back-to-back from the same account
 * intermittently timing out at whichever step ran soonest after the
 * previous one — not always the first, and neither raising the shared
 * login timeout nor this delay (real staging-side settling time between
 * consecutive real executions — never before the first one, never for a
 * skipped gap) alone eliminated it, just reduced how often it hit. Real,
 * repeated evidence pointed to intermittent staging-side slowness, not a
 * bug in this code — the same 3 underlying primitives already passed
 * cleanly, repeatedly, in Step 15's own separate live proofs.
 *
 * LOGIN_IDENTITY_TIMEOUT_PATTERN below gets exactly one real retry (a
 * fresh login, not a cached/assumed one) — scoped narrowly to that one
 * specific known-flaky wait, never to a genuine completed-but-failed
 * check (outcome.passed===false skips this catch block entirely) or any
 * other kind of thrown error. A retry that also fails still reports
 * failed, honestly — this absorbs one-off staging hiccups, it never
 * masks a real problem.
 */
const LOGIN_IDENTITY_TIMEOUT_PATTERN = /getByPlaceholder\('Search your practice'/;

export async function executeImpactedTest({ plan, runners, db, runId, testbook, delayBetweenRunsMs = 8000, artifactDirectory = null, audit = null, sealer = sealEvidence }) {
  const results = [];
  let executedAny = false;
  for (const cell of plan.cells) {
    if (!cell.covered) {
      results.push({ ...cell, executed: false });
      continue;
    }
    const runner = runners[cell.externalId];
    if (!runner) throw new Error(`No native runner registered for covered case "${cell.externalId}".`);
    if (executedAny && delayBetweenRunsMs > 0) await new Promise((resolve) => setTimeout(resolve, delayBetweenRunsMs));
    executedAny = true;
    const startedAt = Date.now();
    let status, actual, retried = false, screenshot = null, reason = null;
    try {
      const outcome = await runner();
      status = outcome.passed ? "passed" : "failed";
      actual = outcome.actual;
      screenshot = outcome.screenshot ?? null;
      reason = outcome.reason ?? null;
    } catch (error) {
      screenshot = takeEvidence(error)?.screenshot ?? null;
      if (!LOGIN_IDENTITY_TIMEOUT_PATTERN.test(error.message)) {
        status = "failed";
        actual = `Execution error: ${error.message}`;
        reason = actual;
      } else {
        retried = true;
        try {
          const outcome = await runner();
          status = outcome.passed ? "passed" : "failed";
          actual = `(retried once after the first login timed out) ${outcome.actual}`;
          screenshot = outcome.screenshot ?? null;
          reason = outcome.reason ?? null;
        } catch (retryError) {
          status = "failed";
          actual = `Execution error (after one retry): ${retryError.message}`;
          reason = actual;
          screenshot = takeEvidence(retryError)?.screenshot ?? null;
        }
      }
    }
    const definition = testbook.resolveCurrentDefinition(cell.externalId);
    const scenarioResultId = randomUUID();
    db.prepare(
      `INSERT INTO scenario_results(id,run_id,scenario,title,status,expected,actual,duration_ms,healed,test_case_id,test_definition_version_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      scenarioResultId,
      runId,
      cell.externalId,
      `${cell.featureName} — ${cell.recordState} record`,
      status,
      `Real, live-verified behavior for ${cell.featureName} (${cell.recordState} record) — see the case's registered source for exactly what this proves.`,
      actual,
      Date.now() - startedAt,
      0,
      definition?.testCaseId ?? null,
      definition?.versionId ?? null,
    );
    // Evidence capture (real gap hit live 2026-09-23: a failed run had no
    // screenshot and no plain-English explanation, just a JSON blob). Its
    // outcome is recorded explicitly — 'saved', 'none_captured' or
    // 'save_failed' — instead of being swallowed: a screenshot that could
    // not be saved never changes the check's pass/fail, but it must never
    // look like a fully evidenced result either.
    let evidenceStatus = screenshot ? "saved" : "none_captured";
    if (screenshot && artifactDirectory) {
      try {
        mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
        const filename = `${randomUUID()}.png.enc`;
        writeFileSync(join(artifactDirectory, filename), await sealer(screenshot), { mode: 0o600 });
        db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?)").run(randomUUID(), runId, scenarioResultId, "screenshot", filename, now());
      } catch {
        evidenceStatus = "save_failed";
        audit?.("evidence.save_failed", scenarioResultId, { runId, scenario: cell.externalId });
      }
    } else if (screenshot && !artifactDirectory) {
      evidenceStatus = "not_persisted";
    }
    db.prepare("UPDATE scenario_results SET evidence_status=? WHERE id=?").run(evidenceStatus, scenarioResultId);
    if (status === "failed" && (reason || evidenceStatus === "save_failed")) {
      const questionId = randomUUID();
      const text = [reason, evidenceStatus === "save_failed" ? "The failure screenshot could not be saved, so this result has no visual evidence." : null].filter(Boolean).join(" ");
      db.prepare("INSERT INTO clarifications(id,run_id,question,created_at) VALUES(?,?,?,?)").run(questionId, runId, text, now());
      audit?.("clarification.opened", questionId, { runId, scenario: cell.externalId });
    }
    results.push({ ...cell, executed: true, status, actual, retried, scenarioResultId, evidenceStatus });
  }
  return results;
}
