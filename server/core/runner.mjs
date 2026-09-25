import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Plan,
  descriptions,
  isAllowedRequest,
  evaluateLocatorCandidate,
} from "./contracts.mjs";
import { openProposals } from "./proposals.mjs";
import { loadTestCaseDirectory, runTestCase, takeFailedStep } from "./dsl.mjs";
import { classifyStepFailure, classifyThrown, EVIDENCE_SAVE_FAILED } from "./failure-class.mjs";
import { finalizeFromSavedResults, finalizeRun, finalizeCancelledRun } from "./run-outcome.mjs";
import { openTestBook } from "./testbook.mjs";
import { now } from "./store.mjs";
const aliases = ["Sign in", "Log in", "Login"];

// V5 Step 4 — each scenario's primitive sequence is declarative DSL
// (server/dsl/login/*.yaml, validated by server/core/dsl.mjs) instead of
// hardcoded control flow. Loaded and schema-validated once at module load:
// an invalid or malformed test case definition fails service startup
// rather than failing mid-run. Exported (with raw source) so the TestBook
// (Step 5) can sync from the exact same entries without a second read.
export const loginTestCases = loadTestCaseDirectory(
  join(dirname(fileURLToPath(import.meta.url)), "..", "dsl", "login"),
);
const testCases = Object.fromEntries(
  Object.entries(loginTestCases).map(([key, entry]) => [key, entry.definition]),
);
// Only these scenarios resolve a candidate submit control worth evaluating
// for a LOCATOR_REPAIR proposal (password_masked/empty_fields never submit).
const LOCATOR_EVALUATED_SCENARIOS = new Set([
  "valid_login",
  "invalid_password",
  "logout",
]);
const TESTBOOK_FEATURE = {
  featureName: "Authentication",
  featureDescription:
    "Sign in, sign out, and session behavior for the Lawcus workspace.",
  suiteName: "login-essentials",
  suiteDescription:
    "The five bounded login checks currently automated against the local fixture.",
  priority: "normal",
};
export async function executeRun({
  db,
  audit,
  runId,
  origin,
  artifactDirectory,
  signal,
}) {
  const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
  const book = db
    .prepare("SELECT * FROM runbooks WHERE id=?")
    .get(run.runbook_id);
  if (book.environment_id !== "fixture")
    throw new Error("External execution is disabled.");
  const plan = Plan.parse(JSON.parse(book.definition));
  const previous = run.path_id
    ? db.prepare("SELECT * FROM execution_paths WHERE id=?").get(run.path_id)
    : null;
  const old = previous ? JSON.parse(previous.fingerprint) : null;
  let label = old?.buttonName || "Sign in";
  let browser;
  // Failures are classified per check (functional / infrastructure / automation /
  // integrity / unclassified) and the run is finalized from what was recorded by
  // the same code as every other run (run-outcome.mjs): only a FUNCTIONAL failure
  // fails a run; a check that could not run, or whose evidence could not be
  // saved, leaves it inconclusive, and never a pass.
  let completedScenarios = 0;
  let cancelled = false;
  let proposed = 0;
  const proposals = openProposals(db, audit);
  const testbook = openTestBook(db, audit);
  // Cheap and idempotent (a handful of hash comparisons against 5 cases) —
  // safe to run every executeRun call so both real usage and tests always
  // exercise the full TestBook linkage, not just a one-time startup sync.
  testbook.syncCases({ ...TESTBOOK_FEATURE, entries: loginTestCases });
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  try {
    // V5 section 17: "Use headed mode for interactive local runs when
    // useful." Headless remains the default (and is what every automated
    // test relies on); QA_HEADED=1 opens a visible, slowed-down window so
    // the operator can watch a local run.
    const headed = process.env.QA_HEADED === "1";
    browser = await chromium.launch({
      headless: !headed,
      chromiumSandbox: true,
      ...(headed ? { slowMo: 350 } : {}),
    });
    for (const scenario of plan.scenarios) {
      // Cooperative cancellation, checked between scenarios rather than
      // mid-Playwright-action: aborting live browser work partway through
      // an action has no clean, universal primitive in Playwright and risks
      // leaving a context in an inconsistent state. The scenario already in
      // flight finishes (or times out on its own existing timeouts); no
      // scenario_results row is fabricated for one that never started.
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      const id = randomUUID();
      const started = Date.now();
      let context;
      let page;
      let status = "passed";
      let actual = descriptions[scenario].expected;
      let classification = null;
      let candidate = label;
      let screenshotName;
      let traceName;
      try {
        context = await browser.newContext({
          serviceWorkers: "block",
          acceptDownloads: false,
          viewport: { width: 1200, height: 800 },
        });
        context.setDefaultTimeout(3500);
        context.setDefaultNavigationTimeout(7000);
        await context.route("**/*", (route) =>
          isAllowedRequest(
            route.request().url(),
            route.request().method(),
            origin,
          )
            ? route.continue()
            : route.abort("blockedbyclient"),
        );
        await context.routeWebSocket(/.*/, (socket) => socket.close());
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false,
        });
        page = await context.newPage();
        page.on("dialog", (dialog) => void dialog.dismiss());
        // V5 Step 4 — run the scenario's declarative DSL definition. Every
        // primitive it references is resolved through the same fail-closed
        // gate (server/core/primitives.mjs) the runner used directly before
        // this layer existed; an unknown/unapproved primitive id in the DSL
        // fails the run rather than silently skipping.
        const scope = await runTestCase(testCases[scenario], {
          ctx: { page, origin, aliases },
        });
        if (LOCATOR_EVALUATED_SCENARIOS.has(scenario)) {
          candidate = scope.submit.candidate;
          // V5 Step 1 — automatic trusted locator repair is removed.
          // A candidate locator now produces a LOCATOR_REPAIR proposal and the
          // trusted path is left exactly as it was. `label` is NOT reassigned.
          const candidacy = evaluateLocatorCandidate({
            current: label,
            candidate,
            sameAssertion: true,
            uniqueCandidate: true,
            knownAlias: aliases.includes(candidate),
            postconditionPassed: true,
          });
          if (candidacy.proposalWarranted) {
            proposed++;
            proposals.create({
              type: "LOCATOR_REPAIR",
              summary: `Login submit control resolved by the alias “${candidate}” instead of the trusted “${label}”.`,
              trigger: `locator_alias_resolved during scenario ${scenario}`,
              subjectKind: "locator",
              subjectId: "login.submit",
              proposedValue: candidate,
              evidence: [
                { runId, scenario, resolvedBy: "known_semantic_alias" },
              ],
              confidence: candidacy.confidence,
              risk: "medium",
              impactedTests: [scenario],
              requiredApproverRole: "engineering",
              generatedBy: "runner",
              runId,
            });
            audit("proposal.locator-repair.raised", runId, {
              from: label,
              to: candidate,
              scenario,
              note: "Trusted locator unchanged pending operator approval.",
            });
          }
        }
      } catch (error) {
        classification = classifyStepFailure(error, takeFailedStep(error));
        status = "failed";
        const functional = classification.failureClass === "functional";
        actual = functional
          ? "The expected login behavior was not observed, or the page could not be resolved safely. The expected result has been preserved."
          : `The check could not be completed. ${classification.explanation}`;
        const clarificationId = randomUUID();
        db.prepare(
          "INSERT INTO clarifications(id,run_id,question,created_at) VALUES(?,?,?,?)",
        ).run(
          clarificationId,
          runId,
          functional
            ? `While checking “${descriptions[scenario].title}”, I could not confirm: ${descriptions[scenario].expected} Is this an intentional behavior change or should it be reported as a defect?`
            : `${classification.explanation} [${classification.failureClass}: ${classification.reasonCode}] While checking “${descriptions[scenario].title}” nothing was concluded about the application.`,
          now(),
        );
        audit("clarification.opened", clarificationId, { runId, scenario });
      } finally {
        if (page) {
          try {
            screenshotName = `${randomUUID()}.png`;
            await page.screenshot({
              path: join(artifactDirectory, screenshotName),
              mask: [page.locator("input")],
              fullPage: true,
            });
          } catch {
            if (screenshotName)
              try {
                unlinkSync(join(artifactDirectory, screenshotName));
              } catch {}
            screenshotName = undefined;
          }
        }
        if (context) {
          try {
            traceName = `${randomUUID()}.zip`;
            await context.tracing.stop({
              path: join(artifactDirectory, traceName),
            });
          } catch {
            traceName = undefined;
          }
          await context.close().catch(() => {});
        }
      }
      const evidenceStatus = screenshotName && traceName ? "saved" : page ? "save_failed" : "none_captured";
      if ((!screenshotName || !traceName) && status === "passed") {
        // An evidence-save failure is an integrity problem, not a behavioral
        // result: the check is not counted as passed, and the run is
        // inconclusive rather than failed.
        status = "failed";
        classification = EVIDENCE_SAVE_FAILED;
        actual =
          "The browser assertion completed, but required evidence could not be saved. This check is not counted as passed.";
        const clarificationId = randomUUID();
        db.prepare(
          "INSERT INTO clarifications(id,run_id,question,created_at) VALUES(?,?,?,?)",
        ).run(
          clarificationId,
          runId,
          `${classification.explanation} [${classification.failureClass}: ${classification.reasonCode}]`,
          now(),
        );
        audit("clarification.opened", clarificationId, { runId, scenario });
      }
      const linked = testbook.resolveCurrentDefinition(testCases[scenario].id);
      db.prepare(
        `INSERT INTO scenario_results(
           id,run_id,scenario,title,status,expected,actual,duration_ms,healed,
           test_case_id,test_definition_version_id,failure_class,reason_code,evidence_status)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        runId,
        scenario,
        descriptions[scenario].title,
        status,
        descriptions[scenario].expected,
        actual,
        Date.now() - started,
        0, // Step 1: runs never record an automatic repair.
        linked?.testCaseId ?? null,
        linked?.versionId ?? null,
        classification?.failureClass ?? null,
        classification?.reasonCode ?? null,
        evidenceStatus,
      );
      for (const [kind, name] of [
        ["screenshot", screenshotName],
        ["trace", traceName],
      ])
        if (name)
          db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?)").run(
            randomUUID(),
            runId,
            id,
            kind,
            name,
            now(),
          );
      completedScenarios++;
    }
    if (cancelled) {
      finalizeCancelledRun(db, runId, { planned: plan.scenarios.length });
      audit("run.cancelled", runId, {
        completed: completedScenarios,
        total: plan.scenarios.length,
      });
      return;
    }
    const verdict = finalizeFromSavedResults(db, runId, {
      planned: plan.scenarios.length,
      extraSummary: `${proposed ? `${proposed} locator repair proposal awaiting approval. ` : ""}${run.replay ? "Saved execution path reused." : "First execution."} No model calls during execution. Local test application only.`,
    });
    if (verdict.outcome === "passed") {
      if (!old || old.buttonName !== label) {
        const pathId = randomUUID();
        const version =
          (db
            .prepare(
              "SELECT MAX(version) AS v FROM execution_paths WHERE runbook_id=?",
            )
            .get(book.id).v || 0) + 1;
        db.prepare("INSERT INTO execution_paths VALUES(?,?,?,?,?)").run(
          pathId,
          book.id,
          version,
          JSON.stringify({
            buttonName: label,
            emailLabel: "Email address",
            passwordLabel: "Password",
            assertionContract: "synthetic-login-v1",
            environment: "fixture",
          }),
          now(),
        );
        audit("path.saved", pathId, { runbookId: book.id, version });
      }
    }
    audit("run.completed", runId, {
      status: verdict.status,
      outcome: verdict.outcome,
      passed: verdict.passed,
      failed: verdict.failed,
      proposed,
      checks: plan.scenarios.length,
    });
  } catch (error) {
    // Whatever stopped the run is recorded, classified and counted from what was
    // saved, never swallowed into one generic sentence.
    finalizeRun(db, runId, { planned: plan.scenarios.length, error });
    audit("run.interrupted", runId, { reasonCode: classifyThrown(error).reasonCode });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
