import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Plan,
  descriptions,
  isAllowedRequest,
  evaluateLocatorCandidate,
} from "./contracts.mjs";
import { openProposals } from "./proposals.mjs";
import { parseTestCase, runTestCase } from "./dsl.mjs";
import { now } from "./store.mjs";
const aliases = ["Sign in", "Log in", "Login"];

// V5 Step 4 — each scenario's primitive sequence is now declarative DSL
// (server/dsl/login/*.yaml, validated by server/core/dsl.mjs) instead of
// hardcoded control flow here. Loaded and schema-validated once at module
// load: an invalid or malformed test case definition fails the service
// startup rather than failing mid-run.
const dslDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dsl", "login");
const loadCase = (name) =>
  parseTestCase(readFileSync(join(dslDir, `${name}.yaml`), "utf8"));
const testCases = {
  password_masked: loadCase("password_masked"),
  empty_fields: loadCase("empty_fields"),
  valid_login: loadCase("valid_login"),
  invalid_password: loadCase("invalid_password"),
  logout: loadCase("logout"),
};
// Only these scenarios resolve a candidate submit control worth evaluating
// for a LOCATOR_REPAIR proposal (password_masked/empty_fields never submit).
const LOCATOR_EVALUATED_SCENARIOS = new Set([
  "valid_login",
  "invalid_password",
  "logout",
]);
export async function executeRun({
  db,
  audit,
  runId,
  origin,
  artifactDirectory,
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
  let failed = 0;
  let proposed = 0;
  const proposals = openProposals(db, audit);
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
      const id = randomUUID();
      const started = Date.now();
      let context;
      let page;
      let status = "passed";
      let actual = descriptions[scenario].expected;
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
      } catch {
        failed++;
        status = "failed";
        actual =
          "The expected login behavior was not observed, or the page could not be resolved safely. The expected result has been preserved.";
        const clarificationId = randomUUID();
        db.prepare(
          "INSERT INTO clarifications(id,run_id,question,created_at) VALUES(?,?,?,?)",
        ).run(
          clarificationId,
          runId,
          `While checking “${descriptions[scenario].title}”, I could not confirm: ${descriptions[scenario].expected} Is this an intentional behavior change or should it be reported as a defect?`,
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
      if ((!screenshotName || !traceName) && status === "passed") {
        failed++;
        status = "failed";
        actual =
          "The browser assertion completed, but required evidence could not be saved. This check is not counted as passed.";
      }
      db.prepare("INSERT INTO scenario_results VALUES(?,?,?,?,?,?,?,?,?)").run(
        id,
        runId,
        scenario,
        descriptions[scenario].title,
        status,
        descriptions[scenario].expected,
        actual,
        Date.now() - started,
        0, // Step 1: runs never record an automatic repair.
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
    }
    if (!failed) {
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
    const summary = `${plan.scenarios.length} checks completed. ${plan.scenarios.length - failed} passed. ${failed} need review.${proposed ? ` ${proposed} locator repair proposal awaiting approval.` : ""} ${run.replay ? "Saved execution path reused." : "First execution."} No model calls during execution. Local test application only.`;
    db.prepare(
      "UPDATE runs SET status=?,finished_at=?,summary=? WHERE id=?",
    ).run(failed ? "failed" : "passed", now(), summary, runId);
    audit("run.completed", runId, {
      failed,
      proposed,
      checks: plan.scenarios.length,
    });
  } catch {
    db.prepare(
      "UPDATE runs SET status='interrupted',finished_at=?,summary=? WHERE id=?",
    ).run(
      now(),
      "The browser runner could not complete. No successful result is claimed. Check that Chromium is installed and the local test application is available.",
      runId,
    );
    audit("run.interrupted", runId, { reason: "runner-unavailable" });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
