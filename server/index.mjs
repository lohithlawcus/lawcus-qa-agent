import {runLive,checkBrowser,liveDescriptions,connectInBrowser} from './core/live-runner.mjs';
import {planWithAI} from './core/ai-planner.mjs';
import {keychain} from './core/secrets.mjs';
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
import { executeRun } from "./core/runner.mjs";
import { openProposals } from "./core/proposals.mjs";
import { startFixture } from "./fixture.mjs";
const directory = resolve("work/runtime");
mkdirSync(directory, { recursive: true, mode: 0o700 });
// Bind the fixture first so a duplicate service cannot mark active jobs interrupted.
const fixture = await startFixture();
const { db, audit } = openStore(directory);
const proposals = openProposals(db, audit);
// section 14: only an interactive operator identity may approve or reject —
// never the runner, AI planner, recorder or network observer. This service
// is single-operator (one Mac, one local session), so the OS account name
// is a stable, non-spoofable identity for every decision made here.
const approverIdentity = `operator:${userInfo().username}`;
const artifactDirectory = join(directory, "artifacts");
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
        let result;
        planning=true;
        try {
          result = input.environmentId==='lawcus'
            ? input.planner==='standard'
              ? {plan:{title:'Login essentials',scenarios:['password_masked','empty_fields','valid_login','logout']},source:'standard',modelCalls:0}
              : await planWithAI(input.intent)
            : await createPlan(input.intent);
        } finally {planning=false;}
        const id = randomUUID();
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
        audit("run.started", id, { runbookId: book.id, replay: !!previous });
        const execute=book.environment_id==='lawcus'?runLive:executeRun;
        void execute({
          db,
          audit,
          runId: id,
          origin: fixture.origin,
          artifactDirectory,
        }).catch(() => {
          db.prepare(
            "UPDATE runs SET status='interrupted',finished_at=?,summary='Execution stopped unexpectedly.' WHERE id=?",
          ).run(now(), id);
        });
        json(res, 202, { id });
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
