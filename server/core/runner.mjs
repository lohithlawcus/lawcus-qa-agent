import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  Plan,
  descriptions,
  isAllowedRequest,
  evaluateLocatorCandidate,
} from "./contracts.mjs";
import { openProposals } from "./proposals.mjs";
import { resolvePrimitive } from "./primitives.mjs";
import { now } from "./store.mjs";
const aliases = ["Sign in", "Log in", "Login"];
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
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
        // V5 Step 3 — every browser action/assertion below runs through the
        // Approved Primitive Registry (server/core/primitives.mjs) instead of
        // inline Playwright code. resolvePrimitive() fails closed on any
        // unknown, unapproved or tampered implementation.
        await resolvePrimitive("auth.open_login_page").run({ page, origin });
        const { email, password } = await resolvePrimitive(
          "auth.ensure_login_fields",
        ).run({ page });
        if (scenario === "password_masked") {
          await resolvePrimitive("auth.assert_password_masked").run({
            password,
          });
        } else if (scenario === "empty_fields") {
          const resolved = await resolvePrimitive(
            "auth.resolve_submit_control",
          ).run({ page, aliases });
          await resolved.locator.click();
          await resolvePrimitive("auth.assert_empty_fields_blocked").run({
            page,
            email,
            password,
          });
        } else {
          await resolvePrimitive("auth.fill_credentials").run({
            email,
            password,
            credentials: {
              email: "qa@example.test",
              password:
                scenario === "invalid_password"
                  ? "Incorrect-fixture-value"
                  : "Fixture-only-123!",
            },
          });
          const resolved = await resolvePrimitive(
            "auth.resolve_submit_control",
          ).run({ page, aliases });
          candidate = resolved.candidate;
          await resolved.locator.click();
          if (scenario === "invalid_password") {
            await resolvePrimitive(
              "auth.assert_invalid_credentials_rejected",
            ).run({ page });
            await resolvePrimitive("auth.assert_protected_route_blocked").run(
              { page, origin },
            );
          } else {
            await resolvePrimitive("auth.assert_authenticated_workspace").run(
              { page },
            );
            if (scenario === "logout") {
              await resolvePrimitive("auth.logout").run({ page });
              await resolvePrimitive(
                "auth.assert_protected_route_blocked",
              ).run({ page, origin });
            }
          }
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
