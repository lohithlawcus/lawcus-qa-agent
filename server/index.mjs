import {runLive,checkBrowser,liveDescriptions,connectInBrowser} from './core/live-runner.mjs';
import { createModelRouter, recordModelUsage } from './ai/router.mjs';
import { createOpenAIProvider } from './ai/providers/openai.mjs';
import {keychain, readSecret} from './core/secrets.mjs';
import {openEvidence} from './core/setup.mjs';
import {readFile} from 'node:fs/promises';
import {CredentialSetup,setupStatus,saveCredentials} from './core/setup.mjs';
import { createServer } from "node:http";
import { createReadStream, mkdirSync } from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { resolve, join } from "node:path";
import { openStore, now } from "./core/store.mjs";
import {
  PlanRequest,
  RunRequest,
  AnswerRequest,
  DecisionRequest,
  createPlan,
  validateExecution,
  descriptions,
} from "./core/contracts.mjs";
import { executeRun, loginTestCases } from "./core/runner.mjs";
import { openProposals } from "./core/proposals.mjs";
import { openTestBook } from "./core/testbook.mjs";
import { buildRunManifest, ManifestError } from "./core/manifest.mjs";
import { resolveIntent } from "./core/intent.mjs";
import { openKnowledge } from "./core/knowledge.mjs";
import { seedLawcusKnowledge } from "./knowledge/lawcus-seed.mjs";
import { openApiContracts } from "./core/api-contracts.mjs";
import { seedLawcusApiContracts } from "./api-contracts/lawcus-seed.mjs";
import { openEnvironmentAdapter, API_ORIGIN, STAGING, ASSETS } from "./core/environment-adapter.mjs";
import { openNetworkAuthority } from "./core/network-authority.mjs";
import { createSafeApiClient } from "./core/api-client.mjs";
import { openNetworkObservations } from "./core/network-observations.mjs";
import { startFixture } from "./fixture.mjs";
const directory = resolve("work/runtime");
mkdirSync(directory, { recursive: true, mode: 0o700 });
// Bind the fixture first so a duplicate service cannot mark active jobs interrupted.
const fixture = await startFixture();
const { db, audit } = openStore(directory);
const proposals = openProposals(db, audit);
const testbook = openTestBook(db, audit);
// V5 Step 8 — the only place that knows which provider/model handles which
// task (server/ai/router.mjs's TASK_POLICY). Only OpenAI is registered:
// adding a second provider means writing one more server/ai/providers/*
// module and one more line here, never touching a call site.
const modelRouter = createModelRouter({
  providers: { openai: createOpenAIProvider() },
});
// V5 Step 5 — make sure the Authentication / login-essentials cases exist
// (and are on their current version) before the first request, not only
// after the first run; then link any pre-TestBook history by scenario name.
testbook.syncCases({
  featureName: "Authentication",
  featureDescription:
    "Sign in, sign out, and session behavior for the Lawcus workspace.",
  suiteName: "login-essentials",
  suiteDescription:
    "The five bounded login checks currently automated against the local fixture.",
  priority: "normal",
  entries: loginTestCases,
});
testbook.backfillHistory(
  Object.fromEntries(
    Object.entries(loginTestCases).map(([scenario, entry]) => [
      scenario,
      entry.definition.id,
    ]),
  ),
);
const knowledge = openKnowledge(db, audit);
// V5 Step 9 — proposes the real, sourced Contacts/Leads/Contact Custom
// Fields extraction and the self-verified Authentication items. Every
// item/edge lands as pending_review; nothing here approves anything.
seedLawcusKnowledge(knowledge);
// V5 Step 10 — API Contract Registry + Environment Adapter + Network
// Authority. Proposes the one real (OBSERVED_API, unapproved) login
// contract and the "lawcus" environment's adapter/network policy at
// startup — all pending_review, exactly like Knowledge. Nothing here
// grants the Safe API Executor any authority; that only happens once an
// operator approves each of the three independently (section 21).
const apiContracts = openApiContracts(db, audit);
seedLawcusApiContracts(apiContracts);
const environmentAdapter = openEnvironmentAdapter(db, audit);
environmentAdapter.proposeAdapter({
  environmentId: "lawcus",
  apiOrigin: API_ORIGIN,
  appOrigin: STAGING,
  assetsOrigin: ASSETS,
});
const networkAuthority = openNetworkAuthority(db, audit);
networkAuthority.proposeAuthority({
  environmentId: "lawcus",
  // Only what the one seeded contract (POST /login) actually needs —
  // least privilege, not a general-purpose allowance (section 21).
  allowedHosts: [new URL(API_ORIGIN).hostname],
  allowedMethods: ["POST"],
  allowRedirects: false,
});
const apiClient = createSafeApiClient({ environmentAdapter, networkAuthority, apiContracts });
// V5 Step 11 — persistence for the Browser Network Contract Observer
// (server/core/network-observer.mjs), wired into the live staging runner
// below so its results can be attributed to an exact run/scenario.
const networkObservations = openNetworkObservations(db, audit);
// section 14: only an interactive operator identity may approve or reject —
// never the runner, AI planner, recorder or network observer. This service
// is single-operator (one Mac, one local session), so the OS account name
// is a stable, non-spoofable identity for every decision made here.
const approverIdentity = `operator:${userInfo().username}`;
const artifactDirectory = join(directory, "artifacts");
// V5 Step 6 — in-flight runs' cancellation controllers, keyed by run id.
// Only fixture/DSL-based runs are cancellable this way (they're the only
// ones that check a signal); an entry exists only while its run is active.
const activeRuns = new Map();
const sessions = new Map();
const allowedOrigins = new Set(["http://127.0.0.1:5173"]);
const limits = new Map();
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
let browserStatus={ready:false,message:"Check the browser in Environment before a live run."};
let checkingBrowser=false;
let savingCredentials=false;
let planning=false;
let connection={status:'idle',message:''};
let connectionController=null;
const connecting=()=>['starting','waiting'].includes(connection.status);
function same(a, b) {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 12000)
      throw new Error("Request is too large.");
  }
  return JSON.parse(raw || "{}");
}
function runDetail(id) {
  const run = db
    .prepare(
      "SELECT runs.*,runbooks.title,runbooks.environment_id FROM runs JOIN runbooks ON runbooks.id=runs.runbook_id WHERE runs.id=?",
    )
    .get(id);
  if (!run) return null;
  const observed = networkObservations.forRun(id);
  return {
    ...run,
    results: db
      .prepare("SELECT * FROM scenario_results WHERE run_id=?")
      .all(id),
    artifacts: db
      .prepare(
        "SELECT id,scenario_result_id,kind FROM artifacts WHERE run_id=?",
      )
      .all(id),
    clarifications: db
      .prepare("SELECT * FROM clarifications WHERE run_id=?")
      .all(id),
    // Frozen at run creation (section 15); absent for runs from before
    // Step 6 and for the legacy Lawcus live-runner path, which doesn't use
    // the DSL/primitive registry this manifest describes.
    manifest: (() => {
      const row = db
        .prepare("SELECT manifest FROM run_execution_manifests WHERE run_id=?")
        .get(id);
      return row ? JSON.parse(row.manifest) : null;
    })(),
    cancellable: activeRuns.has(id),
    networkObservations: observed.network,
    consoleObservations: observed.console,
  };
}
const server = createServer(
  { requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 8192 },
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    if (req.headers.host !== "127.0.0.1:4319") {
      json(res, 403, { error: "Unrecognized service host." });
      return;
    }
    const origin = req.headers.origin;
    if (!allowedOrigins.has(origin)) {
      json(res, 403, {
        error:
          "This local service accepts requests only from its operator workspace.",
      });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-QA-Client",
      );
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.headers["x-qa-client"] !== "lawcus-workspace") {
      json(res, 403, {
        error: "Open this request from the operator workspace.",
      });
      return;
    }
    const pathname = new URL(req.url, "http://127.0.0.1:4319").pathname;
    if (pathname === "/session" && req.method === "POST") {
      const key = origin;
      const current = limits.get(key) || { count: 0, start: Date.now() };
      if (Date.now() - current.start > 60000) {
        current.count = 0;
        current.start = Date.now();
      }
      current.count++;
      limits.set(key, current);
      if (current.count > 20) {
        json(res, 429, {
          error: "Too many session requests. Please wait a minute.",
        });
        return;
      }
      for (const [token, expires] of sessions)
        if (expires < Date.now()) sessions.delete(token);
      const token = randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      res.setHeader(
        "Set-Cookie",
        `qa_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      );
      json(res, 200, { ok: true });
      return;
    }
    const token = /qa_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const expires =
      token && [...sessions.entries()].find(([key]) => same(key, token))?.[1];
    if (!expires || expires < Date.now()) {
      json(res, 401, {
        error: "Your local session expired. Reload the workspace.",
      });
      return;
    }
    try {
      if(req.method==='POST'&&pathname==='/runner/check'){if(connecting()||checkingBrowser||db.prepare("SELECT 1 FROM runs WHERE status='running'").get()){json(res,409,{error:'A runner operation is already active.'});return;}checkingBrowser=true;try{browserStatus=await checkBrowser();json(res,200,browserStatus);}finally{checkingBrowser=false;}return;}
      if(req.method==='GET'&&pathname==='/setup/browser-login'){json(res,200,connection);return;}
      if(req.method==='POST'&&pathname==='/setup/browser-login/cancel'){connectionController?.abort();json(res,200,{message:'Cancelling visible sign-in.'});return;}
      if(req.method==='POST'&&pathname==='/setup/browser-login'){
        if(connecting()||savingCredentials||checkingBrowser||db.prepare("SELECT 1 FROM runs WHERE status='running'").get()){json(res,409,{error:'Wait for the current operation to finish.'});return;}
        const recent=db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='setup.visible-login-started' AND created_at>?").get(new Date(Date.now()-600000).toISOString());
        if(recent.n>=3){json(res,429,{error:'Three visible connection checks were started in ten minutes. Please wait before another.'});return;}
        audit('setup.visible-login-started','lawcus');
        connection={status:'starting',message:'Opening a separate Chromium window for your sign-in.'};
        connectionController=new AbortController();
        void connectInBrowser({audit,signal:connectionController.signal,onState:value=>{connection=value;}})
          .then(value=>{connection=value;browserStatus={ready:true,message:'Chromium and interactive staging login verified.'};})
          .catch(error=>{connection={status:'failed',message:error instanceof Error&&error.message.length<200?error.message:'Visible sign-in could not be verified. The saved account was not updated.'};});
        json(res,202,connection);return;
      }
      if(req.method==='GET'&&pathname==='/setup/status'){json(res,200,await setupStatus());return;}
      if(req.method==='POST'&&pathname==='/setup/credentials'){
        const input=CredentialSetup.parse(await body(req));
        if(connecting()||savingCredentials||db.prepare("SELECT 1 FROM runs WHERE status='running'").get()){json(res,409,{error:'Wait for the active operation before changing credentials.'});return;}
        savingCredentials=true;try{const result=await saveCredentials(input);audit('setup.credential-saved',input.kind,{storage:'macOS Keychain'});json(res,200,result);}finally{savingCredentials=false;}return;
      }
      // V5 Step 10 / Milestone 2 DoD — "one real authorized staging contract
      // verified end-to-end". Purpose-built to exactly one contract, not a
      // generic "call any approved contract with any body" endpoint: this
      // service must never let a client dictate what real request reaches
      // staging (section 22). It reuses the exact safe negative-credential
      // pattern already proven in live-runner.mjs's invalid_password
      // scenario — a deliberately wrong password, so the call can never
      // authenticate or mutate anything real.
      if (req.method === "POST" && pathname === "/api-contracts/verify-login") {
        if (db.prepare("SELECT 1 FROM runs WHERE status='running'").get()) {
          json(res, 409, { error: "Wait for the active run to finish." });
          return;
        }
        const creds = JSON.parse(await readSecret("lawcus-login"));
        const result = await apiClient.execute({
          environmentId: "lawcus",
          semanticId: "lawcus.auth.login",
          requestBody: { email: creds.username, password: randomBytes(24).toString("hex") },
        });
        audit("api_contract.verified", "lawcus.auth.login", {
          status: result.status,
          contractMatch: result.contractMatch,
        });
        json(res, 200, {
          status: result.status,
          contractMatch: result.contractMatch,
          mismatchReason: result.mismatchReason,
        });
        return;
      }
      if (req.method === "GET" && pathname === "/state") {
        json(res, 200, {
          environments: db.prepare("SELECT * FROM environments").all(),
          runbooks: db
            .prepare(
              "SELECT * FROM runbooks ORDER BY created_at DESC LIMIT 100",
            )
            .all()
            .map((b) => ({ ...b, definition: JSON.parse(b.definition) })),
          runs: db
            .prepare(
              "SELECT runs.*,runbooks.title,runbooks.environment_id FROM runs JOIN runbooks ON runbooks.id=runs.runbook_id ORDER BY started_at DESC LIMIT 100",
            )
            .all(),
          clarifications: db
            .prepare(
              "SELECT * FROM clarifications ORDER BY created_at DESC LIMIT 100",
            )
            .all(),
          proposals: proposals.inbox("pending_review"),
          testbook: testbook.tree(),
          knowledgeInbox: {
            items: knowledge.inboxItems(),
            edges: knowledge.inboxEdges(),
          },
          knowledgeApproved: knowledge.approvedByFeature(),
          apiContractsInbox: apiContracts.inbox(),
          apiContractsApproved: apiContracts.approvedByFeature(),
          environmentAdaptersInbox: environmentAdapter.inbox(),
          environmentAdaptersApproved: environmentAdapter.approved(),
          networkAuthoritiesInbox: networkAuthority.inbox(),
          networkAuthoritiesApproved: networkAuthority.approved(),
          audit: db
            .prepare(
              "SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 30",
            )
            .all(),
          planner: "openai-for-staging",
          browser:browserStatus,
        });
        return;
      }
      if (req.method === "POST" && pathname === "/plans") {
        const input = PlanRequest.parse(await body(req));
        if(planning){json(res,409,{error:'A plan is already being created.'});return;}
        // V5 Step 7 / section 32 — resolve known phrasing locally before
        // ever considering an AI call. The "standard" planner never
        // interprets intent at all (it's an explicit fixed-checks choice),
        // so there's nothing to route.
        const routed =
          input.planner === "standard"
            ? null
            : resolveIntent({
                intent: input.intent,
                testbook,
                environmentId: input.environmentId,
              });
        // Generated before planning (not after) so a real AI call can be
        // attributed to the runbook it produced (server/ai/router.mjs
        // records model_usage against this id).
        const id = randomUUID();
        let result;
        planning=true;
        try {
          result = input.environmentId==='lawcus'
            ? input.planner==='standard'
              ? {plan:{title:'Login essentials',scenarios:['password_masked','empty_fields','valid_login','logout']},source:'standard',modelCalls:0}
              : routed?.matched
                ? {plan:{title:'Login essentials',scenarios:routed.scenarios},source:'intent-router',modelCalls:0}
                : await modelRouter.run('planLogin', { intent: input.intent, negativeAllowed: false })
            : await createPlan(input.intent);
        } finally {planning=false;}
        db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
          id,
          1,
          input.environmentId,
          result.plan.title,
          input.planner==='standard'&&input.environmentId==='lawcus' ? 'Standard staging login checks (no AI planning)' : input.intent,
          result.source,
          JSON.stringify(result.plan),
          now(),
        );
        recordModelUsage(db, { result, runbookId: id });
        if (routed)
          db.prepare(
            `INSERT INTO intent_resolutions(
               id,runbook_id,original_prompt,normalized_intent,resolved_locally,
               confidence,matched_feature_id,matched_suite_id,matched_case_ids,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            randomUUID(),
            id,
            input.intent,
            routed.normalizedIntent,
            routed.matched ? 1 : 0,
            routed.confidence,
            routed.featureId,
            routed.suiteId,
            JSON.stringify(routed.caseIds),
            now(),
          );
        audit("runbook.created", id, {
          source: result.source,
          modelCalls: result.modelCalls,
          ...(result.usage?{usage:result.usage}:{}),
        });
        json(res, 201, {
          id,
          title: result.plan.title,
          scenarios: result.plan.scenarios.map((key) => ({
            key,
            ...(input.environmentId==='lawcus'?liveDescriptions[key]:descriptions[key]),
          })),
          source: result.source,
        });
        return;
      }
      if (req.method === "POST" && pathname === "/runs") {
        const input = RunRequest.parse(await body(req));
        const existing = db
          .prepare("SELECT id,runbook_id FROM runs WHERE request_key=?")
          .get(input.idempotencyKey);
        if (existing) {
          if (existing.runbook_id !== input.runbookId) {
            json(res, 409, {
              error: "This request identifier belongs to a different test.",
            });
            return;
          }
          json(res, 200, { id: existing.id });
          return;
        }
        const book = db
          .prepare("SELECT * FROM runbooks WHERE id=?")
          .get(input.runbookId);
        if (!book) {
          json(res, 404, { error: "The saved test could not be found." });
          return;
        }
        if(book.environment_id==='lawcus'){
          if(!browserStatus.ready){json(res,409,{error:'Check the browser connection in Environment first.'});return;}
          const login=await keychain('exists','lawcus-login');if(!login.exists){json(res,409,{error:'Save your staging account in Environment first.'});return;}
          const recent=db.prepare("SELECT COUNT(*) n FROM runs JOIN runbooks ON runbooks.id=runs.runbook_id WHERE runbooks.environment_id='lawcus' AND runs.started_at>?").get(new Date(Date.now()-600000).toISOString());
          if(recent.n>=3){json(res,429,{error:'Three staging runs were started in ten minutes. Please wait before more login attempts.'});return;}
        }else{validateExecution(db.prepare('SELECT * FROM environments WHERE id=?').get(book.environment_id));}
        if (connecting() || savingCredentials || checkingBrowser || db.prepare("SELECT 1 FROM runs WHERE status='running'").get()) {
          json(res, 409, {
            error:
              "A test is already running. Wait for it to finish before starting another.",
          });
          return;
        }
        // V5 Step 6 / section 15 — resolve and freeze the execution
        // manifest BEFORE the run exists at all: if any scenario's DSL
        // references a primitive that isn't approved and hash-matching, or
        // isn't yet synced into the TestBook, the run must not start rather
        // than fail partway through. The legacy Lawcus live-runner doesn't
        // use the DSL/primitive registry, so it has no manifest.
        let manifest = null;
        if (book.environment_id === "fixture") {
          try {
            manifest = buildRunManifest({
              testbook,
              testCases: Object.fromEntries(
                Object.entries(loginTestCases).map(([key, entry]) => [
                  key,
                  entry.definition,
                ]),
              ),
              scenarios: JSON.parse(book.definition).scenarios,
              environmentId: book.environment_id,
              requestedIntent: book.intent,
              requester: approverIdentity,
              triggerSource: input.idempotencyKey ? "operator-run" : "replay",
            });
          } catch (error) {
            if (error instanceof ManifestError) {
              json(res, 409, { error: error.message });
              return;
            }
            throw error;
          }
        }
        const id = randomUUID();
        const previous = db
          .prepare(
            "SELECT * FROM execution_paths WHERE runbook_id=? ORDER BY version DESC LIMIT 1",
          )
          .get(book.id);
        db.prepare(
          "INSERT INTO runs(id,runbook_id,status,replay,path_id,started_at,request_key) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id,
          book.id,
          "running",
          previous ? 1 : 0,
          previous?.id || null,
          now(),
          input.idempotencyKey,
        );
        if (manifest)
          db.prepare(
            "INSERT INTO run_execution_manifests(run_id,manifest,created_at) VALUES(?,?,?)",
          ).run(id, JSON.stringify(manifest), now());
        audit("run.started", id, { runbookId: book.id, replay: !!previous });
        const execute = book.environment_id === "lawcus" ? runLive : executeRun;
        const controller = book.environment_id === "fixture" ? new AbortController() : null;
        if (controller) activeRuns.set(id, controller);
        void execute({
          db,
          audit,
          runId: id,
          origin: fixture.origin,
          artifactDirectory,
          apiContracts,
          networkObservations,
          ...(controller ? { signal: controller.signal } : {}),
        })
          .finally(() => activeRuns.delete(id))
          .catch(() => {
            db.prepare(
              "UPDATE runs SET status='interrupted',finished_at=?,summary='Execution stopped unexpectedly.' WHERE id=?",
            ).run(now(), id);
          });
        json(res, 202, { id });
        return;
      }
      const cancel = /^\/runs\/([a-f0-9-]{36})\/cancel$/.exec(pathname);
      if (req.method === "POST" && cancel) {
        const run = db.prepare("SELECT status FROM runs WHERE id=?").get(cancel[1]);
        if (!run) {
          json(res, 404, { error: "Run not found." });
          return;
        }
        if (run.status !== "running") {
          json(res, 409, { error: "This run has already finished." });
          return;
        }
        const controller = activeRuns.get(cancel[1]);
        if (!controller) {
          json(res, 409, {
            error: "This run cannot be cancelled (not a cancellable fixture run).",
          });
          return;
        }
        controller.abort();
        audit("run.cancel-requested", cancel[1], {});
        json(res, 202, { status: "cancel-requested" });
        return;
      }
      const detail = /^\/runs\/([a-f0-9-]{36})$/.exec(pathname);
      if (req.method === "GET" && detail) {
        const result = runDetail(detail[1]);
        json(res, result ? 200 : 404, result || { error: "Run not found." });
        return;
      }
      const artifact = /^\/artifacts\/([a-f0-9-]{36})$/.exec(pathname);
      if (req.method === "GET" && artifact) {
        const item = db
          .prepare("SELECT * FROM artifacts WHERE id=?")
          .get(artifact[1]);
        if (!item) {
          json(res, 404, { error: "Evidence not found." });
          return;
        }
        if (!/^[a-f0-9-]{36}\.(png|zip|png\.enc|json\.enc)$/.test(item.filename))
          throw new Error("Evidence reference is invalid.");
        if(item.filename.endsWith('.enc')){
          const decrypted=await openEvidence(await readFile(join(artifactDirectory,item.filename)));
          const extension=item.kind==='screenshot'?'png':'json';
          res.setHeader('Content-Type',extension==='png'?'image/png':'application/json');
          res.setHeader('Content-Disposition',`attachment; filename="${item.kind}-${item.id}.${extension}"`);
          res.end(decrypted);return;
        }
        res.setHeader(
          "Content-Type",
          item.kind === "screenshot" ? "image/png" : "application/zip",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${item.kind}-${item.id}.${item.kind === "screenshot" ? "png" : "zip"}"`,
        );
        const stream = createReadStream(join(artifactDirectory, item.filename));
        stream.on("error", () => {
          if (!res.headersSent)
            json(res, 404, { error: "Evidence is no longer available." });
          else res.destroy();
        });
        stream.pipe(res);
        return;
      }
      const clarification = /^\/clarifications\/([a-f0-9-]{36})$/.exec(
        pathname,
      );
      if (req.method === "POST" && clarification) {
        const input = AnswerRequest.parse(await body(req));
        const changed = db
          .prepare(
            "UPDATE clarifications SET status='recorded',answer=?,answered_at=? WHERE id=? AND status='open'",
          )
          .run(input.answer, now(), clarification[1]);
        if (!changed.changes) {
          json(res, 409, {
            error: "This question has already been answered or is unavailable.",
          });
          return;
        }
        audit("clarification.answer-recorded", clarification[1], {
          expectationsChanged: false,
        });
        json(res, 200, {
          message:
            "Your answer was recorded. Expected behavior has not been changed. Applying confirmed rule changes is planned for a later version.",
        });
        return;
      }
      const decision = /^\/proposals\/([a-f0-9-]{36})\/(approve|reject)$/.exec(
        pathname,
      );
      if (req.method === "POST" && decision) {
        const [, id, verb] = decision;
        const input = DecisionRequest.parse(await body(req));
        if (verb === "approve") {
          const result = proposals.approve(id, approverIdentity, input.note ?? null);
          json(res, 200, { status: "approved", ...result });
        } else {
          proposals.reject(id, approverIdentity, input.note ?? null);
          json(res, 200, { status: "rejected" });
        }
        return;
      }
      const knowledgeItemDecision = /^\/knowledge\/items\/([a-f0-9-]{36})\/(approve|reject)$/.exec(
        pathname,
      );
      if (req.method === "POST" && knowledgeItemDecision) {
        const [, id, verb] = knowledgeItemDecision;
        const input = DecisionRequest.parse(await body(req));
        const result =
          verb === "approve"
            ? knowledge.approveItem(id, approverIdentity, input.note ?? null)
            : knowledge.rejectItem(id, approverIdentity, input.note ?? null);
        json(res, 200, { status: result.status });
        return;
      }
      const knowledgeEdgeDecision = /^\/knowledge\/edges\/([a-f0-9-]{36})\/(approve|reject)$/.exec(
        pathname,
      );
      if (req.method === "POST" && knowledgeEdgeDecision) {
        const [, id, verb] = knowledgeEdgeDecision;
        const input = DecisionRequest.parse(await body(req));
        const result =
          verb === "approve"
            ? knowledge.approveEdge(id, approverIdentity, input.note ?? null)
            : knowledge.rejectEdge(id, approverIdentity, input.note ?? null);
        json(res, 200, { status: result.status });
        return;
      }
      const apiContractDecision = /^\/api-contracts\/([a-f0-9-]{36})\/(approve|reject)$/.exec(
        pathname,
      );
      if (req.method === "POST" && apiContractDecision) {
        const [, id, verb] = apiContractDecision;
        const input = DecisionRequest.parse(await body(req));
        const result =
          verb === "approve"
            ? apiContracts.approveContract(id, approverIdentity, input.note ?? null)
            : apiContracts.rejectContract(id, approverIdentity, input.note ?? null);
        json(res, 200, { status: result.status });
        return;
      }
      const environmentAdapterDecision = /^\/environment-adapters\/([a-f0-9-]{36})\/(approve|reject)$/.exec(
        pathname,
      );
      if (req.method === "POST" && environmentAdapterDecision) {
        const [, id, verb] = environmentAdapterDecision;
        const input = DecisionRequest.parse(await body(req));
        const result =
          verb === "approve"
            ? environmentAdapter.approveAdapter(id, approverIdentity, input.note ?? null)
            : environmentAdapter.rejectAdapter(id, approverIdentity, input.note ?? null);
        json(res, 200, { status: result.status });
        return;
      }
      const networkAuthorityDecision = /^\/network-authorities\/([a-f0-9-]{36})\/(approve|reject)$/.exec(
        pathname,
      );
      if (req.method === "POST" && networkAuthorityDecision) {
        const [, id, verb] = networkAuthorityDecision;
        const input = DecisionRequest.parse(await body(req));
        const result =
          verb === "approve"
            ? networkAuthority.approveAuthority(id, approverIdentity, input.note ?? null)
            : networkAuthority.rejectAuthority(id, approverIdentity, input.note ?? null);
        json(res, 200, { status: result.status });
        return;
      }
      json(res, 404, { error: "This action is not available." });
    } catch (error) {
      const validation =
        error?.name === "ZodError" || error instanceof SyntaxError;
      json(res, 400, {
        error: validation
          ? "The request is incomplete or invalid. Please check it and try again."
          : error instanceof Error && error.message.length < 400
            ? error.message
            : "The request could not be completed safely.",
      });
    }
  },
);
server.listen(4319, "127.0.0.1", () =>
  console.log(
    "QA service listening on http://127.0.0.1:4319; synthetic test application on http://127.0.0.1:4320",
  ),
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close();
    fixture.server.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
