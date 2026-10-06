import {runLive,checkBrowser,liveDescriptions,connectInBrowser,verifyPersonaInBrowser,startAuthoringSession,runStagingSweepRead,lawcusDeleteHandlers} from './core/live-runner.mjs';
import { z } from "zod";
import { seedLawcusNativeCases, buildNativeRunners, PROTECTED_RESOURCE_IDS } from './testbook/lawcus-native-cases.mjs';
import { planImpactedTest, proposeGapCoverage, executeImpactedTest } from './core/impacted-testing.mjs';
import { openPersonas, PersonaRegistration } from './core/personas.mjs';
import { openAuthoringSessions, AuthoringSessionRequest, AuthoringDiscardRequest } from './core/authoring-sessions.mjs';
import { normalizeCandidateActions, matchActionsToPrimitives, buildProposalSpecs } from './core/recorder.mjs';
import { listPrimitives } from './core/primitives.mjs';
import { summarizeBody } from './core/sanitize.mjs';
import { createModelRouter, recordModelUsage } from './ai/router.mjs';
import { openAiGate } from './ai/gate.mjs';
import { createOpenAIProvider } from './ai/providers/openai.mjs';
import { createChatCompatibleProvider } from './ai/providers/chat-compatible.mjs';
import { AI_PROVIDER_IDS, AI_PROVIDERS } from './ai/providers/catalog.mjs';
import { readAiSettings, writeAiSettings } from './ai/settings.mjs';
import {keychain, readSecret} from './core/secrets.mjs';
import {openEvidence} from './core/setup.mjs';
import {readFile} from 'node:fs/promises';
import {CredentialSetup,setupStatus,saveCredentials,ENVIRONMENT_ACCOUNTS} from './core/setup.mjs';
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
  ImpactedTestRequest,
  KnowledgeImportRequest,
  AiGateToggleRequest,
  LeftoverResolveRequest,
  createPlan,
  validateExecution,
  descriptions,
} from "./core/contracts.mjs";
import { parseKnowledgeMarkdown } from "./core/knowledge-import.mjs";
import { executeRun, loginTestCases } from "./core/runner.mjs";
import { openProposals } from "./core/proposals.mjs";
import { openTestBook } from "./core/testbook.mjs";
import { buildRunManifest, ManifestError } from "./core/manifest.mjs";
import { resolveIntent } from "./core/intent.mjs";
import { openKnowledge } from "./core/knowledge.mjs";
import { openChangeSignals, SIGNAL_KINDS } from "./core/change-signals.mjs";
import { openFactCards } from "./core/fact-cards.mjs";
import { openStagingSweeps, REVIEW_STATUSES } from "./core/staging-sweep.mjs";
import { seedLawcusKnowledge } from "./knowledge/lawcus-seed.mjs";
import { openApiContracts } from "./core/api-contracts.mjs";
import { seedLawcusApiContracts } from "./api-contracts/lawcus-seed.mjs";
import { openEnvironmentAdapter, API_ORIGIN, STAGING, ASSETS } from "./core/environment-adapter.mjs";
import { openNetworkAuthority } from "./core/network-authority.mjs";
import { createSafeApiClient } from "./core/api-client.mjs";
import { openNetworkObservations } from "./core/network-observations.mjs";
import { openResourceOwnership } from "./core/resource-ownership.mjs";
import { openResourceLocks } from "./core/resource-locks.mjs";
import { openMutationJournal } from "./core/mutation-journal.mjs";
import { createCleanupRunner } from "./core/cleanup.mjs";
import { finalizeRun } from "./core/run-outcome.mjs";
import { closeOutCleanup } from "./core/run-cleanup.mjs";
import { sanitizeErrorBody, safeErrorMessage } from "./core/redact.mjs";
import { checkStagingBudget, stagingBusy } from "./core/run-admission.mjs";
import { openStagingLeases, bindSignInRecorder } from "./core/staging-lease.mjs";
import { runPreflight, preflightMessage } from "./core/preflight.mjs";
import { buildCoverageReport } from "./core/coverage-report.mjs";
import { currentCodeRevision } from "./core/code-revision.mjs";
import { startFixture } from "./fixture.mjs";
const directory = resolve("work/runtime");
mkdirSync(directory, { recursive: true, mode: 0o700 });
// Bind the fixture first so a duplicate service cannot mark active jobs interrupted.
const fixture = await startFixture();
const { db, audit } = openStore(directory);
// One staging operation at a time, and every staging sign-in is recorded under it. A lease
// still active at startup belonged to a process that has exited, so it is abandoned.
const stagingLeases = openStagingLeases(db, audit);
stagingLeases.abandonStale();
bindSignInRecorder((purpose) => stagingLeases.recordSignIn({ environmentId: "lawcus", purpose }));
const proposals = openProposals(db, audit);
const testbook = openTestBook(db, audit);
// V5 Step 8 — the only place that knows which provider/model handles which
// task (server/ai/router.mjs's TASK_POLICY). Only OpenAI is registered:
// adding a second provider means writing one more server/ai/providers/*
// module and one more line here, never touching a call site.
// The provider and model come from the saved choice in ai-settings.json (set in
// secure setup); the keys stay in the Keychain. Every provider is fixed in
// server/ai/providers/catalog.mjs, so a key only ever goes to its own base URL.
const providers = { openai: createOpenAIProvider() };
for (const id of AI_PROVIDER_IDS) if (id !== 'openai') providers[id] = createChatCompatibleProvider({ providerId: id });
const modelRouter = createModelRouter({
  providers,
  policy: { get planLogin() { const saved = readAiSettings(directory); return { provider: saved.provider, model: saved.model }; } },
});
// V5 Upgrade Phase U1 — the AI Gate wraps modelRouter; no other module
// may import router.mjs's run() directly from here on. See
// server/ai/gate.mjs for why this exists alongside, not instead of, the
// Step 8 router.
const aiGate = openAiGate(db, audit, { modelRouter });
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
// V5 Step 16 — registers Step 15's real, already-live-verified Contact/Lead
// browser primitives as real TestBook coverage, so the Impact Graph's gap
// detection has genuine cases to check against.
seedLawcusNativeCases(testbook);
const knowledge = openKnowledge(db, audit);
const changeSignals = openChangeSignals(db, audit, { knowledge, testbook });
const factCards = openFactCards(db, { knowledge, testbook });
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
// V5 Step 12 — Persona Session Foundation (section 18). Registering a
// persona is cheap/reversible; only verifyPersonaInBrowser's visible
// sign-in (wired below) can ever move one to 'verified'.
const personas = openPersonas(db, audit);
// V5 Step 13 — Resource Ownership + Locks + Mutation Journal (sections
// 25-28). No feature registers delete/restore handlers yet (no real
// mutating primitive exists until Step 15's Contacts/Custom Fields/Leads
// milestone), so cleanup below runs as a real, honest no-op today — the
// orchestration is wired in now so it's already exercised by every real
// run rather than bolted on later once there's something to actually clean.
const resourceOwnership = openResourceOwnership(db, audit, { protectedResourceIds: PROTECTED_RESOURCE_IDS });
const stagingSweeps = openStagingSweeps(db, audit, { protectedResourceIds: PROTECTED_RESOURCE_IDS });
const resourceLocks = openResourceLocks(db, audit);
const mutationJournal = openMutationJournal(db, audit);
const cleanupRunner = createCleanupRunner({ resourceOwnership, mutationJournal, resourceLocks });
let deletionInFlight = false;
// A lock left 'held' by a run that crashed before releasing it (matching
// store.mjs's own stale-run recovery) is recoverable, never a permanent
// deadlock (section 26).
resourceLocks.recoverStale();
// Section 28 also requires cleanup after "interruption/recovery" — a run
// store.mjs just marked 'interrupted' at startup (the process crashed
// mid-run) never goes through the execute() promise chain below, so it
// would otherwise never get a cleanup pass at all.
for (const row of db.prepare("SELECT id FROM runs WHERE status='interrupted' AND cleanup_status IS NULL").all())
  void cleanupRunner
    .runCleanup({ runId: row.id, deleteHandlers: {}, restoreHandlers: {} })
    .then((result) => db.prepare("UPDATE runs SET cleanup_status=? WHERE id=?").run(result.overall, row.id))
    .catch(() => db.prepare("UPDATE runs SET cleanup_status='failed' WHERE id=?").run(row.id));
// section 14: only an interactive operator identity may approve or reject —
// never the runner, AI planner, recorder or network observer. This service
// is single-operator (one Mac, one local session), so the OS account name
// is a stable, non-spoofable identity for every decision made here.
const approverIdentity = `operator:${userInfo().username}`;
const artifactDirectory = join(directory, "artifacts");
// V5 Step 14 — Recorder / Teaching Mode Foundation (section 29). An open
// authoring session is a live, stateful browser the operator is actively
// using — kept here the same way activeRuns tracks in-flight cancellable
// runs, not persisted as a resumable server-side object (a crashed
// process loses any session still 'open'; the next startup's stale-run
// sweep below has no equivalent for authoring sessions yet, matching this
// step's explicit "Foundation" scope).
const authoringSessions = openAuthoringSessions(db, audit);
const activeAuthoringSessions = new Map();
// V5 Step 6 — in-flight runs' cancellation controllers, keyed by run id.
// Only fixture/DSL-based runs are cancellable this way (they're the only
// ones that check a signal); an entry exists only while its run is active.
const activeRuns = new Map();
const sessions = new Map();
const allowedOrigins = new Set(["http://127.0.0.1:5173"]);
// V5 "add two more urls" (2026-09-17) — the real (non-fixture) Lawcus
// environments the browser-driven Login suite (runLive) can target, derived
// from the same map that already names each one's dedicated Keychain
// account — one source of truth, not a second hardcoded list.
const REAL_LOGIN_ENVIRONMENTS = new Set(Object.keys(ENVIRONMENT_ACCOUNTS));
const limits = new Map();
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  // An error body can carry text derived from a browser, a request or a
  // thrown error; mask credentials before it leaves the process.
  res.end(JSON.stringify(status >= 400 ? sanitizeErrorBody(data) : data));
}
let browserStatus={ready:false,message:"Check the browser in Environment before a live run."};
let checkingBrowser=false;
let savingCredentials=false;
let planning=false;
let connection={status:'idle',message:''};
let connectionController=null;
// V5 Step 12 — one persona visible sign-in at a time, same constraint as
// the primary account's connection state above.
let personaConnection={status:'idle',message:''};
let personaConnectionController=null;
const connecting=()=>['starting','waiting'].includes(connection.status);
const personaConnecting=()=>['starting','waiting'].includes(personaConnection.status);
function same(a, b) {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
async function body(req, maxBytes = 12000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes)
      throw new Error("Request is too large.");
  }
  return JSON.parse(raw || "{}");
}
// Where a person can open an owned record in Lawcus to remove it by hand.
// Only the record kinds this project actually creates; anything else (an
// unconfirmed creation, an unknown type) has no direct link.
function ownedRecordUrl(row) {
  if (row.resource_type === "contact") return `${STAGING}/contact/${row.resource_id}`;
  if (row.resource_type === "lead") return `${STAGING}/lead/${row.resource_id}`;
  return null;
}
const withOpenUrl = (row) => ({ ...row, openUrl: ownedRecordUrl(row) });

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
    resourceOwnership: resourceOwnership.forRun(id).map(withOpenUrl),
    resourceLocks: resourceLocks.forRun(id),
    mutationJournal: mutationJournal.forRun(id),
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
      if(req.method==='POST'&&pathname==='/runner/check'){if(connecting()||checkingBrowser||stagingBusy(db)){json(res,409,{error:'A runner operation is already active.'});return;}checkingBrowser=true;try{browserStatus=await checkBrowser();json(res,200,browserStatus);}finally{checkingBrowser=false;}return;}
      if(req.method==='GET'&&pathname==='/setup/browser-login'){json(res,200,connection);return;}
      if(req.method==='POST'&&pathname==='/setup/browser-login/cancel'){connectionController?.abort();json(res,200,{message:'Cancelling visible sign-in.'});return;}
      if(req.method==='POST'&&pathname==='/setup/browser-login'){
        if(connecting()||savingCredentials||checkingBrowser||stagingBusy(db)){json(res,409,{error:'Wait for the current operation to finish.'});return;}
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
      if(req.method==='GET'&&pathname==='/setup/status'){
        const status=await setupStatus();
        json(res,200,{...status,aiChoice:readAiSettings(directory),aiProviders:AI_PROVIDER_IDS.map(id=>({id,label:AI_PROVIDERS[id].label,configured:Boolean(status.aiProviderConfigured[id]),keyPage:AI_PROVIDERS[id].keyPage,defaultModel:AI_PROVIDERS[id].defaultModel}))});
        return;
      }
      if(req.method==='POST'&&pathname==='/setup/credentials'){
        const input=CredentialSetup.parse(await body(req));
        // V5 Step 12 / section 18: a persona's whole point is a VERIFIED
        // identity. This bypass form-save path (no identity confirmation)
        // stays reserved for the primary account only — a persona
        // credential may only be set by the visible sign-in flow below,
        // after Playwright itself confirms the resulting identity.
        if(input.kind==='lawcus-persona'){json(res,400,{error:'Persona accounts must be verified through visible sign-in, not saved directly.'});return;}
        if(connecting()||savingCredentials||stagingBusy(db)){json(res,409,{error:'Wait for the active operation before changing credentials.'});return;}
        savingCredentials=true;try{const result=await saveCredentials(input);if(input.kind==='ai')writeAiSettings(directory,{provider:input.provider,model:input.model});audit('setup.credential-saved',input.kind,{storage:'macOS Keychain',...(input.kind==='lawcus'?{environmentId:input.environmentId}:input.kind==='lawcus-persona'?{account:input.account}:{})});json(res,200,result);}finally{savingCredentials=false;}return;
      }
      if(req.method==='POST'&&pathname==='/personas'){
        const input=PersonaRegistration.parse(await body(req));
        const persona=personas.registerPersona(input);
        json(res,201,persona);return;
      }
      if(req.method==='GET'&&pathname==='/personas/verify'){json(res,200,personaConnection);return;}
      if(req.method==='POST'&&pathname==='/personas/verify/cancel'){personaConnectionController?.abort();json(res,200,{message:'Cancelling persona sign-in.'});return;}
      const personaVerify=/^\/personas\/([a-f0-9-]{36})\/verify$/.exec(pathname);
      if(req.method==='POST'&&personaVerify){
        if(personaConnecting()||stagingBusy(db)){json(res,409,{error:'Wait for the current operation to finish.'});return;}
        const recent=db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='persona.visible-login-started' AND created_at>?").get(new Date(Date.now()-600000).toISOString());
        if(recent.n>=3){json(res,429,{error:'Three visible persona sign-ins were started in ten minutes. Please wait before another.'});return;}
        const personaId=personaVerify[1];
        audit('persona.visible-login-started',personaId,{});
        personaConnection={status:'starting',message:'Opening a separate Chromium window for the persona sign-in.'};
        personaConnectionController=new AbortController();
        void verifyPersonaInBrowser({personas,personaId,artifactDirectory,verifiedBy:approverIdentity,audit,signal:personaConnectionController.signal,onState:value=>{personaConnection=value;}})
          .then(value=>{personaConnection=value;})
          .catch(error=>{personaConnection={status:'failed',message:error instanceof Error&&error.message.length<200?error.message:'Visible persona sign-in could not be verified. Nothing was saved.'};});
        json(res,202,personaConnection);return;
      }
      const personaRevoke=/^\/personas\/([a-f0-9-]{36})\/revoke$/.exec(pathname);
      if(req.method==='POST'&&personaRevoke){
        const input=DecisionRequest.parse(await body(req));
        const persona=personas.revoke(personaRevoke[1],{revokedBy:approverIdentity,reason:input.note??null});
        json(res,200,persona);return;
      }
      // V5 Step 14 / section 29 — Teach / Record Workflow.
      if(req.method==='POST'&&pathname==='/authoring/sessions'){
        const input=AuthoringSessionRequest.parse(await body(req));
        const session=authoringSessions.start({
          operator:approverIdentity,environmentId:input.environmentId,personaId:input.personaId??null,
          featureName:input.featureName,workflowDescription:input.workflowDescription,
        });
        try{
          const handle=await startAuthoringSession({
            environmentId:input.environmentId,origin:fixture.origin,personaId:input.personaId??null,
            personas,personaDirectory:artifactDirectory,
          });
          activeAuthoringSessions.set(session.id,handle);
          json(res,202,session);
        }catch(error){
          authoringSessions.fail(session.id,error instanceof Error?safeErrorMessage(error):'Could not open the authoring browser.');
          json(res,400,{error:error instanceof Error&&error.message.length<300?error.message:'Could not open the authoring browser.'});
        }
        return;
      }
      if(req.method==='GET'&&pathname==='/authoring/sessions'){json(res,200,authoringSessions.list());return;}
      const authoringSessionGet=/^\/authoring\/sessions\/([a-f0-9-]{36})$/.exec(pathname);
      if(req.method==='GET'&&authoringSessionGet){
        const session=authoringSessions.get(authoringSessionGet[1]);
        if(!session){json(res,404,{error:'Authoring session not found.'});return;}
        const handle=activeAuthoringSessions.get(session.id);
        json(res,200,{
          ...session,
          live:handle?handle.status():null,
          actions:authoringSessions.actionsFor(session.id),
          networkObservations:authoringSessions.networkObservationsFor(session.id),
        });
        return;
      }
      const authoringComplete=/^\/authoring\/sessions\/([a-f0-9-]{36})\/complete$/.exec(pathname);
      if(req.method==='POST'&&authoringComplete){
        const id=authoringComplete[1];
        const handle=activeAuthoringSessions.get(id);
        if(!handle){json(res,409,{error:'This authoring session is not currently open.'});return;}
        const session=authoringSessions.get(id);
        const {actions:rawActions,networkEvents}=await handle.finish();
        activeAuthoringSessions.delete(id);
        const normalized=normalizeCandidateActions(rawActions);
        for(const action of normalized)
          authoringSessions.recordAction(id,{
            sequence:action.sequence,
            actionType:action.actionType,
            locatorCandidate:action.locatorCandidate,
            locatorQuality:action.locatorCandidate.strategy==='css-path'?'unstable':'stable',
            redacted:action.redacted,
            valueSummary:action.valueSummary,
            valueLiteral:action.valueLiteral,
          });
        for(const event of networkEvents){
          let host='',path='';
          try{const u=new URL(event.url);host=u.hostname;path=u.pathname;}catch{}
          authoringSessions.recordNetworkObservation(id,{
            method:event.method,host,path,status:event.status,
            requestSummary:summarizeBody(event.requestBody),
            responseSummary:event.responseBody!=null?summarizeBody(event.responseBody):null,
          });
        }
        const matched=matchActionsToPrimitives(normalized,listPrimitives());
        const testCaseSubjectId=`${session.feature_name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.${session.workflow_description.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,60)}`;
        const specs=buildProposalSpecs({session,actions:matched,testCaseSubjectId});
        const proposalIds=[];
        const proposalErrors=[];
        for(const spec of specs){
          try{proposalIds.push(proposals.create({...spec,generatedBy:'recorder'}));}
          catch(error){proposalErrors.push(error instanceof Error?safeErrorMessage(error):'Could not create a proposal.');}
        }
        const completed=authoringSessions.complete(id,{proposalIds});
        json(res,200,{...completed,proposalIds,proposalErrors,actionCount:normalized.length});
        return;
      }
      const authoringDiscard=/^\/authoring\/sessions\/([a-f0-9-]{36})\/discard$/.exec(pathname);
      if(req.method==='POST'&&authoringDiscard){
        const id=authoringDiscard[1];
        const input=AuthoringDiscardRequest.parse(await body(req));
        const handle=activeAuthoringSessions.get(id);
        if(handle){await handle.abort();activeAuthoringSessions.delete(id);}
        const session=authoringSessions.discard(id,input.reason??null);
        json(res,200,session);
        return;
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
        if (stagingBusy(db)) {
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
          // The latest confirmation per environment — real facts the
          // operator stated in conversation (see migrations 003, 019),
          // never assumed. Drives the per-environment card in the
          // Environment tab instead of hardcoded copy.
          environmentConfirmations: db
            .prepare(
              `SELECT environment_id, facts FROM environment_confirmations ec
               WHERE version = (SELECT MAX(version) FROM environment_confirmations WHERE environment_id = ec.environment_id)`,
            )
            .all()
            .map((row) => ({ environmentId: row.environment_id, facts: JSON.parse(row.facts) })),
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
          leftovers: resourceOwnership.allLeftovers().map(withOpenUrl),
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
          personas: personas.list(),
          authoringSessions: authoringSessions.list(),
          audit: db
            .prepare(
              "SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 30",
            )
            .all(),
          planner: "openai-for-staging",
          browser:browserStatus,
          aiUsage: aiGate.usageSummary(),
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
          result = REAL_LOGIN_ENVIRONMENTS.has(input.environmentId)
            ? input.planner==='standard'
              ? {plan:{title:'Login essentials',scenarios:['password_masked','empty_fields','valid_login','logout']},source:'standard',modelCalls:0}
              : routed?.matched
                ? {plan:{title:'Login essentials',scenarios:routed.scenarios},source:'intent-router',modelCalls:0}
                : await aiGate.run('planLogin', { intent: input.intent, negativeAllowed: false }, { requester: approverIdentity, reason: 'Local intent router could not resolve this prompt to a known suite.' })
            : await createPlan(input.intent);
        } finally {planning=false;}
        db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
          id,
          1,
          input.environmentId,
          result.plan.title,
          input.planner==='standard'&&REAL_LOGIN_ENVIRONMENTS.has(input.environmentId) ? 'Standard staging login checks (no AI planning)' : input.intent,
          result.source,
          JSON.stringify(result.plan),
          now(),
        );
        const modelUsageId = recordModelUsage(db, { result, runbookId: id });
        if (result.aiGateRequestId) aiGate.finalizeRequest(result.aiGateRequestId, { runbookId: id, modelUsageId });
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
            ...(REAL_LOGIN_ENVIRONMENTS.has(input.environmentId)?liveDescriptions[key]:descriptions[key]),
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
        if(REAL_LOGIN_ENVIRONMENTS.has(book.environment_id)){
          if(!browserStatus.ready){json(res,409,{error:'Check the browser connection in Environment first.'});return;}
          const login=await keychain('exists',ENVIRONMENT_ACCOUNTS[book.environment_id]);if(!login.exists){json(res,409,{error:'Save your staging account in Environment first.'});return;}
          const budget=checkStagingBudget(db,book.environment_id);
          if(!budget.ok){json(res,429,{error:'Three staging runs were started in ten minutes. Please wait before more login attempts.'});return;}
          const pre=await runPreflight({artifactDirectory});if(!pre.ok){json(res,409,{error:preflightMessage(pre),preflight:pre.checks});return;}
        }else{validateExecution(db.prepare('SELECT * FROM environments WHERE id=?').get(book.environment_id));}
        if (connecting() || savingCredentials || checkingBrowser || stagingBusy(db)) {
          json(res, 409, {
            error:
              "A test is already running. Wait for it to finish before starting another.",
          });
          return;
        }
        const lease = stagingLeases.acquire({ environmentId: book.environment_id, kind: "run" });
        if (!lease.ok) { json(res, 409, { error: "Another staging operation is running. Wait for it to finish before starting this one." }); return; }
        // The lease is released on every exit. Once the run is handed to its background work,
        // that work releases it after cleanup.
        let handedOff = false;
        try {
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
          "INSERT INTO runs(id,runbook_id,status,replay,path_id,started_at,request_key,code_revision) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          id,
          book.id,
          "running",
          previous ? 1 : 0,
          previous?.id || null,
          now(),
          input.idempotencyKey,
          currentCodeRevision(),
        );
        if (manifest)
          db.prepare(
            "INSERT INTO run_execution_manifests(run_id,manifest,created_at) VALUES(?,?,?)",
          ).run(id, JSON.stringify(manifest), now());
        audit("run.started", id, { runbookId: book.id, replay: !!previous });
        const execute = REAL_LOGIN_ENVIRONMENTS.has(book.environment_id) ? runLive : executeRun;
        const controller = book.environment_id === "fixture" ? new AbortController() : null;
        if (controller) activeRuns.set(id, controller);
        handedOff = true;
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
          .catch((error) => {
            // Recorded, classified and counted from what was saved, like every other run.
            finalizeRun(db, id, { planned: null, error });
          })
          .finally(async () => {
            activeRuns.delete(id);
            // Section 28: cleanup runs after pass, failure, cancellation
            // OR interruption — unconditionally, here, regardless of how
            // execute() settled. It never touches runs.status; only its
            // own separate cleanup_status column.
            try {
              const result = await cleanupRunner.runCleanup({ runId: id, deleteHandlers: {}, restoreHandlers: {} });
              db.prepare("UPDATE runs SET cleanup_status=? WHERE id=?").run(result.overall, id);
              audit("run.cleanup-completed", id, { overall: result.overall });
            } catch {
              db.prepare("UPDATE runs SET cleanup_status='failed' WHERE id=?").run(id);
            }
            stagingLeases.release(lease.id);
          });
        json(res, 202, { id });
        return;
        } finally {
          if (!handedOff) stagingLeases.release(lease.id);
        }
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
        // acceptLowerAuthority lets a person knowingly approve weaker evidence
        // (observed/inferred/assumed) over a documented or product-approved
        // fact; it needs a note saying why.
        const input = z.object({ note: z.string().trim().min(1).max(1000).optional(), acceptLowerAuthority: z.boolean().optional() }).strict().parse(await body(req));
        try {
          const result =
            verb === "approve"
              ? knowledge.approveItem(id, approverIdentity, input.note ?? null, { acceptLowerAuthority: input.acceptLowerAuthority === true })
              : knowledge.rejectItem(id, approverIdentity, input.note ?? null);
          json(res, 200, { status: result.status });
        } catch (error) {
          if (error?.code === "lower_authority") { json(res, 409, { error: error.message, code: error.code }); return; }
          throw error;
        }
        return;
      }
      if (req.method === "POST" && pathname === "/knowledge/duplicates/collapse") {
        const input = z.object({ apply: z.boolean().default(false) }).strict().parse(await body(req));
        json(res, 200, knowledge.collapseDuplicates({ approver: approverIdentity, apply: input.apply }));
        return;
      }
      // A read-only look at what this tool may have left in the staging tenant.
      // Reads the tenant's own list pages and keeps only records with this tool's
      // naming; a person decides what each candidate is. Changes nothing in staging.
      // What the run history supports: which checks count as coverage, and a quality baseline. Read-only.
      if (req.method === "GET" && pathname === "/coverage") {
        json(res, 200, buildCoverageReport(db));
        return;
      }
      if (pathname === "/sweeps" || pathname.startsWith("/sweeps/")) {
        try {
          if (req.method === "GET" && pathname === "/sweeps") {
            json(res, 200, { sweeps: stagingSweeps.list() });
            return;
          }
          if (req.method === "POST" && pathname === "/sweeps") {
            z.object({}).strict().parse(await body(req));
            if (!browserStatus.ready) { json(res, 409, { error: "Check the browser connection in Environment first." }); return; }
            const login = await keychain("exists", "lawcus-login");
            if (!login.exists) { json(res, 409, { error: "Save your staging account in Environment first." }); return; }
            if (connecting() || savingCredentials || checkingBrowser || stagingBusy(db)) {
              json(res, 409, { error: "A test or another sweep is running. Wait for it to finish before sweeping." });
              return;
            }
            const sweepBudget = checkStagingBudget(db, "lawcus");
            if (!sweepBudget.ok) { json(res, 429, { error: "Three staging sign-ins were used in ten minutes. Please wait before sweeping." }); return; }
            const sweepPre = await runPreflight({ artifactDirectory });
            if (!sweepPre.ok) { json(res, 409, { error: preflightMessage(sweepPre), preflight: sweepPre.checks }); return; }
            const lease = stagingLeases.acquire({ environmentId: "lawcus", kind: "sweep" });
            if (!lease.ok) { json(res, 409, { error: "Another staging operation is running. Wait for it to finish before sweeping." }); return; }
            let handedOff = false;
            try {
              const sweepId = stagingSweeps.begin({ environmentId: "lawcus", requestedBy: approverIdentity });
              handedOff = true;
              void stagingSweeps.run({ sweepId, reader: ({ cutoff }) => runStagingSweepRead({ cutoff }) }).finally(() => stagingLeases.release(lease.id));
              json(res, 202, { sweepId });
              return;
            } finally {
              if (!handedOff) stagingLeases.release(lease.id);
            }
          }
          let hit;
          if (req.method === "GET" && (hit = /^\/sweeps\/([a-f0-9-]{36})$/.exec(pathname))) {
            const sweep = stagingSweeps.get(hit[1]);
            if (!sweep) { json(res, 404, { error: "That sweep could not be found." }); return; }
            json(res, 200, { sweep });
            return;
          }
          if (req.method === "POST" && (hit = /^\/sweeps\/records\/([a-f0-9-]{36})\/review$/.exec(pathname))) {
            const input = z.object({ status: z.enum(REVIEW_STATUSES), note: z.string().max(1000).optional() }).strict().parse(await body(req));
            json(res, 200, { record: stagingSweeps.review(hit[1], { ...input, actor: approverIdentity }) });
            return;
          }
        } catch (error) {
          if (error?.code === "not_found") { json(res, 404, { error: error.message }); return; }
          if (error?.code === "sweep_running") { json(res, 409, { error: error.message }); return; }
          throw error;
        }
      }
      // KB-03 reviewer views. Read-only.
      if (req.method === "GET" && (pathname === "/knowledge/facts" || pathname.startsWith("/knowledge/facts/"))) {
        if (pathname === "/knowledge/facts") {
          const query = new URL(req.url, "http://127.0.0.1:4319").searchParams;
          json(res, 200, { facts: factCards.listFacts({ status: query.get("status"), feature: query.get("feature") }), unsourced: factCards.unsourcedFacts().length });
          return;
        }
        const card = factCards.factCard(decodeURIComponent(pathname.slice("/knowledge/facts/".length)));
        if (!card) { json(res, 404, { error: "That Knowledge item could not be found." }); return; }
        json(res, 200, { fact: card });
        return;
      }
      if (req.method === "GET" && pathname === "/knowledge/unsourced") {
        json(res, 200, { facts: factCards.unsourcedFacts() });
        return;
      }
      // KB-05 change loop. Recording, analysing and proposing only: nothing
      // here approves Knowledge or changes a test or an expected result.
      const signalId = "([a-f0-9-]{36})";
      const uuidRoute = (suffix) => new RegExp(`^/change-signals/${signalId}${suffix}$`).exec(pathname);
      if (pathname === "/change-signals" || pathname.startsWith("/change-signals/") || pathname === "/knowledge/stale") {
        try {
          if (req.method === "GET" && pathname === "/change-signals") {
            json(res, 200, { signals: changeSignals.list(), kinds: SIGNAL_KINDS });
            return;
          }
          if (req.method === "GET" && pathname === "/knowledge/stale") {
            const days = Number(new URL(req.url, "http://127.0.0.1:4319").searchParams.get("days") ?? 90);
            json(res, 200, { facts: changeSignals.staleFacts({ olderThanDays: Number.isFinite(days) && days > 0 ? days : 90 }) });
            return;
          }
          if (req.method === "POST" && pathname === "/change-signals") {
            const input = z.object({
              kind: z.enum(SIGNAL_KINDS), title: z.string(), body: z.string(),
              source: z.string().optional(), sourceRef: z.string().optional(), occurredAt: z.string().optional(),
            }).strict().parse(await body(req));
            const signal = changeSignals.submit({ ...input, submittedBy: approverIdentity });
            const analyzed = signal.duplicate ? signal : changeSignals.analyze(signal.id);
            json(res, signal.duplicate ? 200 : 201, { signal: analyzed, duplicate: Boolean(signal.duplicate) });
            return;
          }
          let hit;
          if (req.method === "GET" && (hit = uuidRoute(""))) { json(res, 200, changeSignals.get(hit[1])); return; }
          if (req.method === "POST" && (hit = uuidRoute("/analyze"))) { json(res, 200, { signal: changeSignals.analyze(hit[1]) }); return; }
          if (req.method === "POST" && (hit = uuidRoute("/propose-revision"))) {
            const input = z.object({ semanticId: z.string(), statement: z.string(), provenance: z.string().optional() }).strict().parse(await body(req));
            json(res, 200, changeSignals.proposeRevision({ signalId: hit[1], ...input, proposedBy: approverIdentity }));
            return;
          }
          if (req.method === "POST" && (hit = uuidRoute("/flag"))) {
            const input = z.object({ itemId: z.string(), note: z.string().optional() }).strict().parse(await body(req));
            json(res, 200, { flag: changeSignals.flagForReview({ signalId: hit[1], ...input, actor: approverIdentity }) });
            return;
          }
          if (req.method === "POST" && (hit = uuidRoute("/dismiss"))) {
            const input = z.object({ note: z.string().optional() }).strict().parse(await body(req));
            json(res, 200, { signal: changeSignals.dismiss({ signalId: hit[1], ...input, actor: approverIdentity }) });
            return;
          }
          if (req.method === "POST" && (hit = /^\/change-signals\/flags\/([a-f0-9-]{36})\/resolve$/.exec(pathname))) {
            const input = z.object({ resolution: z.string(), note: z.string().optional() }).strict().parse(await body(req));
            json(res, 200, { flag: changeSignals.resolveFlag({ flagId: hit[1], ...input, actor: approverIdentity }) });
            return;
          }
        } catch (error) {
          if (error?.code === "not_found") { json(res, 404, { error: error.message }); return; }
          throw error;
        }
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
      // V5 "efficiently update our knowledge base" (2026-09-18) — bulk
      // authoring: parses a whole document of Knowledge items/edges at
      // once, but proposes NOTHING if any of it fails to parse (fail
      // closed on a broken batch, never a partial import). Every item and
      // edge that does get proposed lands as pending_review exactly like
      // the seed file's items always have — nothing here is auto-approved.
      //
      // proposeItem()/proposeEdge() are each a separate write, so a later
      // item failing (e.g. a Related Tests id that doesn't really exist —
      // knowledge_item_tests has a real FK to test_cases) would otherwise
      // leave the earlier items in this same batch already committed,
      // silently breaking the "never a partial import" guarantee above.
      // Real bug, caught live 2026-09-18 testing this exact endpoint.
      // Wrapping the whole batch in one transaction makes it atomic.
      if (req.method === "POST" && pathname === "/knowledge/import") {
        const input = KnowledgeImportRequest.parse(await body(req, 200000));
        const { items, edges, errors } = parseKnowledgeMarkdown(input.text);
        if (errors.length) {
          json(res, 400, { errors });
          return;
        }
        db.exec("BEGIN IMMEDIATE");
        let proposedItems, proposedEdges;
        try {
          proposedItems = items.map((item) => knowledge.proposeItem(item));
          proposedEdges = edges.map((edge) => knowledge.proposeEdge(edge));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          const fkError = error instanceof Error && /FOREIGN KEY constraint failed/.test(error.message);
          json(res, 400, {
            errors: [
              {
                line: 0,
                message: fkError
                  ? "One item cites a Related Test or API Contract id that doesn't actually exist. Fix or remove that reference — nothing was imported."
                  : error instanceof Error
                    ? error.message
                    : "Import failed.",
              },
            ],
          });
          return;
        }
        audit("knowledge.bulk_import", randomUUID(), {
          items: proposedItems.length,
          edges: proposedEdges.length,
        });
        json(res, 200, {
          proposed: {
            items: proposedItems.map((i) => ({ semanticId: i.semantic_id, version: i.version })),
            edges: proposedEdges.length,
          },
        });
        return;
      }
      // V5 Step 16 — Natural-Language Impacted Testing (section 42's flow):
      // local intent -> Impact Graph -> approved Knowledge -> TestBook
      // coverage -> gap detection. Pure and side-effect-free — safe to call
      // freely while exploring a prompt before committing to a real run.
      if (req.method === "POST" && pathname === "/impacted-tests/plan") {
        const input = ImpactedTestRequest.parse(await body(req));
        const plan = planImpactedTest({ intent: input.intent, knowledge, testbook });
        json(res, 200, plan);
        return;
      }
      if (req.method === "POST" && pathname === "/impacted-tests/run") {
        const input = ImpactedTestRequest.parse(await body(req));
        if (!browserStatus.ready) { json(res, 409, { error: "Check the browser connection in Environment first." }); return; }
        const login = await keychain("exists", "lawcus-login");
        if (!login.exists) { json(res, 409, { error: "Save your staging account in Environment first." }); return; }
        const recent = db.prepare("SELECT COUNT(*) n FROM runs JOIN runbooks ON runbooks.id=runs.runbook_id WHERE runbooks.environment_id='lawcus' AND runs.started_at>?").get(new Date(Date.now() - 600000).toISOString());
        if (recent.n >= 3) { json(res, 429, { error: "Three staging runs were started in ten minutes. Please wait before more." }); return; }
        if (connecting() || savingCredentials || checkingBrowser || stagingBusy(db)) {
          json(res, 409, { error: "A test is already running. Wait for it to finish before starting another." });
          return;
        }
        const plan = planImpactedTest({ intent: input.intent, knowledge, testbook });
        // A plan that is not matched, or is blocked (a prerequisite is missing, a
        // cycle, nothing runnable), is shown but never run.
        if (!plan.matched || plan.status === "blocked") { json(res, 200, { plan, results: [], filedProposals: [] }); return; }
        // Same staging run budget as /runs and MCP — every cell is a real login
        // from the one shared QA account.
        const impactedBudget = checkStagingBudget(db, "lawcus");
        if (!impactedBudget.ok) { json(res, 429, { error: "Three staging runs were started in ten minutes. Please wait before more login attempts." }); return; }
        const impactedPre = await runPreflight({ artifactDirectory });
        if (!impactedPre.ok) { json(res, 409, { error: preflightMessage(impactedPre), preflight: impactedPre.checks }); return; }

        const lease = stagingLeases.acquire({ environmentId: "lawcus", kind: "impacted_run" });
        if (!lease.ok) { json(res, 409, { error: "Another staging operation is running. Wait for it to finish before starting this one." }); return; }
        try {
        const runbookId = randomUUID();
        db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
          runbookId, 1, "lawcus", `Impacted test: ${plan.subjectFeatureName}`, input.intent, "impacted-testing",
          JSON.stringify({ scenarios: plan.cells.map((c) => c.externalId) }), now(),
        );
        const runId = randomUUID();
        db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at,code_revision) VALUES(?,?,?,?,?,?)").run(runId, runbookId, "running", 0, now(), currentCodeRevision());
        audit("impacted_test.started", runId, { intent: input.intent, cells: plan.cells.length, gaps: plan.gaps.length });

        const runners = buildNativeRunners({ apiContracts, mutationJournal, runId, resourceOwnership });

        let results = [];
        let filedProposals = [];
        try {
          results = await executeImpactedTest({ plan, runners, db, runId, testbook, artifactDirectory, audit });
          filedProposals = proposeGapCoverage({ proposals, plan });
          // Verdict from what actually executed — zero executed checks, or
          // only some of the planned ones, is never a green run.
          finalizeRun(db, runId, { results, extraSummary: `${plan.gaps.length} gap(s) proposed for review.` });
        } catch (error) {
          finalizeRun(db, runId, { planned: plan.cells.length, error });
          throw error;
        } finally {
          // Cleanup runs however execution ended. It never changes the run's
          // pass/fail; it records what this run left behind in staging.
          await closeOutCleanup({ db, cleanupRunner, runId, audit });
        }
        audit("impacted_test.completed", runId, { results: results.length, filedProposals: filedProposals.length });
        json(res, 200, { runId, plan, results, filedProposals });
        return;
        } finally {
          stagingLeases.release(lease.id);
        }
      }
      if (req.method === "GET" && pathname === "/leftovers") {
        json(res, 200, { leftovers: resourceOwnership.allLeftovers().map(withOpenUrl) });
        return;
      }
      // A person records what they did about a record a run left in staging.
      // This only writes the decision; nothing here touches Lawcus.
      const leftoverResolve = /^\/leftovers\/([a-f0-9-]{36})\/resolve$/.exec(pathname);
      if (req.method === "POST" && leftoverResolve) {
        const input = LeftoverResolveRequest.parse(await body(req));
        try {
          const row = resourceOwnership.resolveLeftover(leftoverResolve[1], { action: input.action, actor: approverIdentity, note: input.note });
          json(res, 200, { leftover: withOpenUrl(row) });
        } catch (error) {
          if (error?.code === "not_found") { json(res, 404, { error: error.message }); return; }
          if (error?.code === "not_leftover") { json(res, 409, { error: error.message }); return; }
          throw error;
        }
        return;
      }
      // Deleting a staging record a person has approved, one record at a time.
      // These routes only read the list or record the approval/withdrawal; the
      // delete itself runs separately (cleanup.mjs runApprovedDeletions), and
      // nothing here touches Lawcus. Approval is human-only (resource-ownership.mjs).
      if (req.method === "GET" && pathname === "/deletions") {
        json(res, 200, {
          approved: resourceOwnership.approvedForDeletion("lawcus").map(withOpenUrl),
          candidates: resourceOwnership.allLeftovers().filter((r) => r.cleanup_policy === "manual" && r.cleanup_status === "pending").map(withOpenUrl),
        });
        return;
      }
      const deletionDecision = /^\/deletions\/([a-f0-9-]{36})\/(approve|revoke)$/.exec(pathname);
      if (req.method === "POST" && deletionDecision) {
        try {
          const row = deletionDecision[2] === "approve"
            ? resourceOwnership.approveDeletion(deletionDecision[1], { approver: approverIdentity })
            : resourceOwnership.revokeDeletion(deletionDecision[1], { approver: approverIdentity });
          json(res, 200, { record: withOpenUrl(row) });
        } catch (error) {
          if (error?.code === "not_found") { json(res, 404, { error: error.message }); return; }
          if (error?.code && /^(not_pending|kept_on_purpose|protected_resource|not_approved|non_human_approver|no_approver)$/.test(error.code)) { json(res, 409, { error: error.message }); return; }
          throw error;
        }
        return;
      }
      // Carries out ONE approved deletion per request, through the Lawcus handler.
      // Refused while another staging operation runs, while the preflight fails, or
      // when the shared sign-in budget is spent (deletions count as sign-ins).
      if (req.method === "POST" && pathname === "/deletions/run") {
        // The operator names the exact record confirmed on screen; the server never picks one itself.
        const { ownershipId } = z.object({ ownershipId: z.string().uuid() }).strict().parse(await body(req));
        if (deletionInFlight) { json(res, 409, { error: "A deletion is already running." }); return; }
        if (connecting() || savingCredentials || checkingBrowser || stagingBusy(db)) { json(res, 409, { error: "Wait for the active operation to finish before deleting." }); return; }
        if (!resourceOwnership.approvedForDeletion("lawcus").some((r) => r.id === ownershipId)) { json(res, 409, { error: "That record is no longer approved for deletion. Nothing was deleted." }); return; }
        const pre = await runPreflight({ artifactDirectory });
        if (!pre.ok) { json(res, 409, { error: preflightMessage(pre) }); return; }
        const budget = checkStagingBudget(db, "lawcus");
        const recentDeletions = db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='deletion.run' AND created_at>?").get(new Date(Date.now() - 600000).toISOString()).n;
        if (!budget.ok || budget.recent + recentDeletions >= budget.limit) { json(res, 429, { error: "Three staging sign-ins were used in ten minutes. Please wait before deleting." }); return; }
        const lease = stagingLeases.acquire({ environmentId: "lawcus", kind: "deletion" });
        if (!lease.ok) { json(res, 409, { error: "Another staging operation is running. Nothing was deleted." }); return; }
        deletionInFlight = true;
        try {
          const result = await cleanupRunner.runApprovedDeletions({ environmentId: "lawcus", limit: 1, ownershipId, deleteHandlers: lawcusDeleteHandlers() });
          const target = result.deleted[0] ?? result.failed[0] ?? result.waiting[0] ?? null;
          audit("deletion.run", approverIdentity, { ownershipId, resourceId: target?.resource_id ?? null, deleted: result.deleted.length, failed: result.failed.length, waiting: result.waiting.length, refused: result.refused?.reason ?? null });
          if (result.refused) { json(res, 409, { deleted: 0, failed: 0, waiting: result.waiting.length, ownershipId, refused: result.refused.reason, message: result.refused.reason === "no_handler" ? "This kind of record cannot be deleted by the tool yet. It stays approved and nothing was deleted." : "That record is no longer approved. Nothing was deleted." }); return; }
          json(res, 200, {
            ownershipId,
            resourceId: target?.resource_id ?? null,
            deleted: result.deleted.length,
            failed: result.failed.length,
            waiting: result.waiting.length,
            message: result.failed[0]?.cleanup_note ?? null,
          });
        } finally {
          deletionInFlight = false;
          stagingLeases.release(lease.id);
        }
        return;
      }
      // V5 Upgrade Phase U1 — the AI Gate's own kill switch. Human-only
      // (aiGate.setEnabled refuses a non-human approverIdentity the same
      // way every other decision route does), and every toggle is
      // audited.
      if (req.method === "POST" && pathname === "/ai-gate/toggle") {
        const input = AiGateToggleRequest.parse(await body(req));
        const result = aiGate.setEnabled(input.enabled, approverIdentity);
        json(res, 200, result);
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
