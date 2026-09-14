"use client";
import SecureSetup from "./secure-setup";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Play,
  ShieldCheck,
  FlaskConical,
  History,
  BookOpen,
  LockKeyhole,
  Check,
  X,
  AlertTriangle,
  LoaderCircle,
  ChevronRight,
  Download,
  Activity,
  Terminal,
  Globe,
  RotateCcw,
  Inbox,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
const API = "http://127.0.0.1:4319";
type Run = {
  id: string;
  runbook_id: string;
  environment_id: string;
  title: string;
  status: string;
  replay: number;
  summary: string;
  started_at: string;
  model_calls: number;
};
type Book = {
  id: string;
  title: string;
  version: number;
  environment_id: string;
  source: string;
  intent: string;
  created_at: string;
  definition: { scenarios: string[] };
};
type Question = {
  id: string;
  question: string;
  status: string;
  answer?: string;
};
type Proposal = {
  id: string;
  type: string;
  status: string;
  summary: string;
  trigger: string;
  subject_kind: string;
  subject_id: string;
  current_value: string | null;
  proposed_value: string;
  confidence: number | null;
  risk: string;
  required_approver_role: string;
  generated_by: string;
  created_at: string;
  expires_at: string;
};
type CaseStats = {
  executions: number;
  passed: number;
  failed: number;
  lastExecutionAt: string | null;
  lastStatus: string | null;
  lastPassAt: string | null;
  lastFailureAt: string | null;
};
type TestCase = {
  id: string;
  externalId: string;
  title: string;
  description: string;
  layer: string;
  priority: string;
  risk: string;
  status: string;
  tags: string[];
  currentVersion: number;
  stats: CaseStats;
};
type TestSuite = {
  id: string;
  name: string;
  description: string;
  cases: TestCase[];
};
type Feature = {
  id: string;
  name: string;
  description: string;
  suites: TestSuite[];
};
type State = {
  environments: { id: string; name: string; url: string }[];
  runbooks: Book[];
  runs: Run[];
  clarifications: Question[];
  proposals: Proposal[];
  testbook: Feature[];
  audit: { id: string; action: string; created_at: string }[];
  planner: string;
};
type Detail = Run & {
  results: {
    id: string;
    title: string;
    status: string;
    expected: string;
    actual: string;
    duration_ms: number;
    healed: number;
  }[];
  artifacts: { id: string; scenario_result_id: string; kind: string }[];
  clarifications: Question[];
};
type Plan = {
  id: string;
  title: string;
  scenarios: { key: string; title: string; expected: string }[];
  source: string;
};
async function request<T = Record<string, string>>(
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      "X-QA-Client": "lawcus-workspace",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await res.json();
  if (res.status === 401 && retry) {
    await request("/session", {}, false);
    return request<T>(path, body, false);
  }
  if (!res.ok)
    throw new Error(
      typeof data === "object" && data !== null && "error" in data
        ? String(data.error)
        : "The request could not be completed.",
    );
  return data as T;
}
const date = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export default function Home() {
  const [tab, setTab] = useState("workspace");
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState("");
  const [environment, setEnvironment] = useState("lawcus");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setState(await request<State>("/state"));
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await request("/session", {});
        if (alive) await refresh();
      } catch {
        if (alive)
          setError(
            "The local runner is not connected. Start the QA service to create and run tests.",
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!state?.runs.some((r) => r.status === "running")) return;
    const timer = setInterval(async () => {
      try {
        await refresh();
        if (detail) setDetail(await request<Detail>("/runs/" + detail.id));
      } catch {
        setError(
          "The connection to the runner was interrupted. Reload to check the saved run status.",
        );
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [state, detail, refresh]);
  const hasState = state !== null;
  useEffect(() => {
    if (!hasState) return;
    const sync = () => { void refresh().catch(() => {}); };
    const timer = setInterval(sync, 10000);
    window.addEventListener("focus", sync);
    return () => { clearInterval(timer); window.removeEventListener("focus", sync); };
  }, [hasState, refresh]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  async function planTest(planner: "ai" | "standard" = "ai") {
    await action(async () => {
      const p = await request<Plan>("/plans", {
        intent: planner === "standard" ? "Standard staging login checks" : intent,
        planner,
        environmentId: environment,
      });
      setPlan(p);
      setDetail(null);
      await refresh();
    });
  }
  async function runTest(id: string) {
    await action(async () => {
      const run = await request("/runs", {
        runbookId: id,
        idempotencyKey: crypto.randomUUID(),
      });
      setDetail(await request<Detail>("/runs/" + run.id));
      setTab("workspace");
      await refresh();
    });
  }
  async function openRun(id: string) {
    await action(async () => {
      setDetail(await request<Detail>("/runs/" + id));
      setPlan(null);
      setTab("workspace");
    });
  }
  async function decide(id: string, verb: "approve" | "reject") {
    await action(async () => {
      const note = (notes[id] || "").trim();
      await request(`/proposals/${id}/${verb}`, note ? { note } : {});
      setNotes((n) => {
        const next = { ...n };
        delete next[id];
        return next;
      });
      setMessage(
        verb === "approve"
          ? "Proposal approved. The trusted value has been updated."
          : "Proposal rejected. The trusted value is unchanged.",
      );
      await refresh();
    });
  }
  async function download(id: string, kind: string) {
    await action(async () => {
      const res = await fetch(API + "/artifacts/" + id, {
        credentials: "include",
        headers: { "X-QA-Client": "lawcus-workspace" },
      });
      if (!res.ok) throw new Error("Evidence could not be downloaded.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${kind}-${id}.${kind === "screenshot" ? "png" : res.headers.get("Content-Type")?.includes("application/json")?"json":"zip"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const running = state?.runs.some((r) => r.status === "running");
  const passed = state?.runs.filter((r) => r.status === "passed").length || 0;
  const questions =
    state?.clarifications.filter((q) => q.status === "open") || [];
  const pendingProposals = state?.proposals || [];
  return (
    <div className="shell">
      <header className="masthead">
        <Link className="brand" href="/">
          <div className="brand-mark">
            <FlaskConical size={21} />
          </div>
          <span>
            lawcus <strong>QA Agent</strong>
          </span>
        </Link>
        <div className="header-right">
          <span className="local-label">
            <LockKeyhole size={13} /> Local development
          </span>
          <div className="avatar" aria-label="Local operator">
            QA
          </div>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="workspace-tabs">
        <div className="nav-wrap">
          <TabsList variant="line" className="top-nav">
            <TabsTrigger value="workspace">
              <Terminal />
              Test workspace
            </TabsTrigger>
            <TabsTrigger value="saved">
              <BookOpen />
              Saved tests
            </TabsTrigger>
            <TabsTrigger value="testbook">
              <ListChecks />
              TestBook
            </TabsTrigger>
            <TabsTrigger value="history">
              <History />
              Run history
            </TabsTrigger>
            <TabsTrigger value="proposals">
              <Inbox />
              Proposals
              {pendingProposals.length > 0 && (
                <Badge variant="outline">{pendingProposals.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="safety">
              <ShieldCheck />
              Safety & coverage
            </TabsTrigger>
            <TabsTrigger value="environment">
              <Globe />
              Environment
            </TabsTrigger>
          </TabsList>
          <span className="version">V1 · Login slice</span>
        </div>
        <main className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR QA WORKSPACE</div>
              <h1>
                {tab === "workspace"
                  ? "What would you like to test?"
                  : tab === "saved"
                    ? "Your reusable tests"
                    : tab === "testbook"
                      ? "The record of what's actually proven"
                      : tab === "history"
                        ? "Every run, accounted for"
                        : tab === "proposals"
                          ? "Nothing changes without your say"
                          : tab === "safety"
                            ? "Confidence needs evidence"
                            : "Connect your test environment"}
              </h1>
              <p>
                {tab === "workspace"
                  ? "Describe the intent. Review the checks. Let the runner handle the steps."
                  : tab === "saved"
                    ? "Saved logical tests stay separate from their browser execution paths."
                    : tab === "testbook"
                      ? "Feature → suite → test case, each on a versioned definition, with its real execution history."
                      : tab === "history"
                        ? "Results and evidence are retained, including failed and interrupted runs."
                        : tab === "proposals"
                          ? "A candidate change to a locator or test never applies itself. Review the evidence, then approve or reject."
                          : tab === "safety"
                            ? "A bounded first version, with clear limits and no silent changes to expected behavior."
                            : "Start with an isolated test application, then verify your Lawcus staging access."}
              </p>
            </div>
            <div className="connection">
              <span
                className={state ? "connection-dot" : "connection-dot offline"}
              />
              {state ? "Local runner connected" : "Runner not connected"}
            </div>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <TabsContent value="workspace">
            <div className="work-grid">
              <section className="main-column">
                <div className="prompt-card">
                  <div className="card-top">
                    <span className="section-label">
                      <FlaskConical size={16} /> NEW TEST
                    </span>
                    <Badge variant="outline">
                      {environment === "lawcus"
                        ? "OpenAI login planner"
                        : "Built-in login planner"}
                    </Badge>
                  </div>
                  <label htmlFor="intent" className="sr-only">
                    What would you like to test?
                  </label>
                  <Textarea
                    id="intent"
                    className="intent-input"
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    placeholder="Test the login page."
                    maxLength={1000}
                  />
                  <div className="prompt-footer">
                    <Select
                      value={environment}
                      onValueChange={(v) => {
                        setEnvironment(v);
                        setPlan(null);
                      }}
                    >
                      <SelectTrigger
                        className="environment-select"
                        aria-label="Test environment"
                      >
                        <FlaskConical size={15} />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fixture">
                          Local test application
                        </SelectItem>
                        <SelectItem value="lawcus">
                          Lawcus staging
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      className="primary-button"
                      disabled={!intent.trim() || busy || !state}
                      onClick={() => planTest()}
                    >
                      {busy ? (
                        <LoaderCircle className="spin" />
                      ) : (
                        <ArrowUpRight />
                      )}
                      Create test plan
                    </Button>
                  </div>
                </div>
                {environment === "lawcus" && <div className="try-row"><Button variant="outline" disabled={busy || !state} onClick={() => planTest("standard")}>Use standard login checks</Button><span>Four fixed checks · No API key needed · Review before running</span></div>}
                <div className="try-row">
                  <span>Try a login request</span>
                  {["Test the login page.", "Thoroughly test login."].map(
                    (text) => (
                      <button key={text} onClick={() => setIntent(text)}>
                        {text}
                        <ChevronRight size={13} />
                      </button>
                    ),
                  )}
                </div>
                {detail ? (
                  <div className="panel result-panel">
                    <div className="panel-heading">
                      <div>
                        <span className="section-label">RUN REPORT</span>
                        <h2>{detail.title}</h2>
                      </div>
                      <Badge className={"status " + detail.status}>
                        {detail.status === "running" ? (
                          <LoaderCircle className="spin" />
                        ) : detail.status === "passed" ? (
                          <Check />
                        ) : (
                          <AlertTriangle />
                        )}
                        {detail.status}
                      </Badge>
                    </div>
                    <p className="report-summary" aria-live="polite">
                      {detail.status === "running"
                        ? "Chromium is running the checks. Results appear as each check completes."
                        : detail.summary}
                    </p>
                    <div className="run-meta">
                      <span>{date(detail.started_at)}</span>
                      <span>
                        {detail.replay
                          ? "Saved path replay"
                          : "First execution"}
                      </span>
                      <span>0 execution model calls</span>
                    </div>
                    <div className="scenario-list">
                      {detail.results.map((r) => (
                        <div className="result-row" key={r.id}>
                          <div className={"result-icon " + r.status}>
                            {r.status === "passed" ? (
                              <Check size={16} />
                            ) : (
                              <AlertTriangle size={16} />
                            )}
                          </div>
                          <div className="scenario-copy">
                            <h3>{r.title}</h3>
                            <p>{r.actual}</p>
                            {r.healed === 1 && (
                              <Badge variant="outline">
                                Technical locator repair confirmed
                              </Badge>
                            )}
                            <div className="evidence-links">
                              {detail.artifacts
                                .filter((a) => a.scenario_result_id === r.id)
                                .map((a) => (
                                  <button
                                    disabled={busy}
                                    key={a.id}
                                    onClick={() => download(a.id, a.kind)}
                                  >
                                    <Download size={13} />
                                    {a.kind}
                                  </button>
                                ))}
                              <span>{(r.duration_ms / 1000).toFixed(1)}s</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {detail.status !== "running" && (
                      <Button
                        variant="outline"
                        disabled={busy || running}
                        onClick={() => runTest(detail.runbook_id)}
                      >
                        <RotateCcw />
                        Run saved test again
                      </Button>
                    )}
                  </div>
                ) : plan ? (
                  <div className="panel">
                    <div className="panel-heading">
                      <div>
                        <span className="section-label">READY FOR REVIEW</span>
                        <h2>{plan.title}</h2>
                      </div>
                      <Badge variant="outline">
                        {plan.scenarios.length} checks
                      </Badge>
                    </div>
                    <p className="subtle">
                      {environment === "lawcus" ? `Review these staging expectations before running. ${plan.source === "standard" ? "This is a fixed plan created without AI." : "OpenAI selected checks from the bounded login contract."}` : "These checks use the synthetic local login contract."}
                    </p>
                    <div className="scenario-list">
                      {plan.scenarios.map((s, i) => (
                        <div className="scenario-row" key={s.key}>
                          <span className="step-number">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <div>
                            <h3>{s.title}</h3>
                            <p>{s.expected}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="plan-bottom">
                      <span>
                        <LockKeyhole size={14} /> {environment==='lawcus'?'Dedicated staging account':'Synthetic data only'}
                      </span>
                      <Button
                        className="primary-button"
                        disabled={busy || running}
                        onClick={() => runTest(plan.id)}
                      >
                        <Play />
                        Run {plan.scenarios.length} checks
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="panel empty-panel">
                    <div className="flow-symbol">
                      <FlaskConical size={26} />
                    </div>
                    <h2>A clear plan before the first click</h2>
                    <p>
                      Your request becomes readable checks, then repeatable
                      browser steps. Start with the login page to verify the
                      complete workflow.
                    </p>
                    <div className="flow-line">
                      <span>
                        <span>1</span>Describe
                      </span>
                      <ChevronRight />
                      <span>
                        <span>2</span>Review
                      </span>
                      <ChevronRight />
                      <span>
                        <span>3</span>Run & learn
                      </span>
                    </div>
                  </div>
                )}
              </section>
              <aside className="side-column">
                <div className="scope-card">
                  <div className="scope-icon">
                    <ShieldCheck size={22} />
                  </div>
                  <h2>Bounded login testing</h2>
                  <p>
                    {environment === "lawcus" ? "Test the dedicated staging account with fixed checks or an AI-selected login plan." : "Test the QA platform against its local synthetic application."}
                  </p>
                  <ul>
                    <li>
                      <Check />
                      Real Chromium execution
                    </li>
                    <li>
                      <Check />
                      Saved, repeatable paths
                    </li>
                    <li>
                      <Check />
                      Encrypted staging evidence
                    </li>
                    <li>
                      <LockKeyhole />
                      Live runs require secure setup
                    </li>
                  </ul>
                  <button onClick={() => setTab("environment")}>
                    Review environment
                    <ArrowUpRight size={15} />
                  </button>
                </div>
                <div className="panel compact">
                  <span className="section-label">THIS WORKSPACE</span>
                  <div className="metric">
                    <span>Saved tests</span>
                    <strong>{state?.runbooks.length || 0}</strong>
                  </div>
                  <div className="metric">
                    <span>Passed runs</span>
                    <strong>{passed}</strong>
                  </div>
                  <div className="metric">
                    <span>Questions to review</span>
                    <strong>{questions.length}</strong>
                  </div>
                  <div className="metric">
                    <span>Proposals to review</span>
                    <strong>{pendingProposals.length}</strong>
                  </div>
                  <div className="small-note">
                    Review each run’s environment and evidence. Login checks do not cover every feature.
                  </div>
                </div>
                <div className="principle">
                  <Activity size={17} />
                  <p>
                    <strong>Reason once. Replay reliably.</strong>
                    <br />
                    Saved regression paths run without model calls.
                  </p>
                </div>
              </aside>
            </div>
          </TabsContent>
          <TabsContent value="saved">
            <div className="panel">
              {!state?.runbooks.length ? (
                <div className="empty-small">
                  <BookOpen />
                  <h2>No saved tests yet</h2>
                  <p>Create your first login plan in the test workspace.</p>
                  <Button onClick={() => setTab("workspace")}>
                    Create a test
                  </Button>
                </div>
              ) : (
                state.runbooks.map((book) => (
                  <div className="list-row" key={book.id}>
                    <div>
                      <h3>{book.title}</h3>
                      <p>
                        {book.intent} · Version {book.version} ·{" "}
                        {book.definition.scenarios.length} checks
                      </p>
                      <span className="subtle">
                        {date(book.created_at)} ·{" "}
                        {book.source === "built-in"
                          ? "Built-in planner"
                          : book.source === "openai" ? "OpenAI planner" : book.source === "standard" ? "Standard checks · no AI" : "Local model"}{" "}
                        · {book.environment_id === "lawcus" ? "Lawcus staging" : "Local test application"}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy || running}
                      onClick={() => runTest(book.id)}
                    >
                      <Play />
                      Run test
                    </Button>
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="testbook">
            <div className="panel">
              {!state?.testbook.length ? (
                <div className="empty-small">
                  <ListChecks />
                  <h2>No test cases yet</h2>
                  <p>
                    Run a login check once and the TestBook fills in on its
                    own — nothing to set up by hand.
                  </p>
                </div>
              ) : (
                state.testbook.map((feature) => (
                  <div key={feature.id} className="testbook-feature">
                    <span className="section-label">{feature.name}</span>
                    <p className="subtle">{feature.description}</p>
                    {feature.suites.map((suite) => (
                      <div key={suite.id}>
                        <h3>{suite.name}</h3>
                        <p className="subtle">{suite.description}</p>
                        {suite.cases.map((testCase) => (
                          <div className="list-row" key={testCase.id}>
                            <div>
                              <h3>{testCase.title}</h3>
                              <div className="inline">
                                <Badge variant="outline">{testCase.layer}</Badge>
                                <Badge variant="outline">{testCase.risk} risk</Badge>
                                <Badge variant="outline">v{testCase.currentVersion}</Badge>
                                <Badge variant="outline">{testCase.status}</Badge>
                              </div>
                              <span className="subtle">
                                {testCase.stats.executions} execution
                                {testCase.stats.executions === 1 ? "" : "s"} ·{" "}
                                {testCase.stats.passed} passed ·{" "}
                                {testCase.stats.failed} failed
                                {testCase.stats.lastExecutionAt
                                  ? ` · last run ${date(testCase.stats.lastExecutionAt)}`
                                  : ""}
                              </span>
                            </div>
                            <Badge
                              className={
                                "status " + (testCase.stats.lastStatus || "")
                              }
                            >
                              {testCase.stats.lastStatus ?? "not yet run"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="history">
            <div className="panel">
              {!state?.runs.length ? (
                <div className="empty-small">
                  <History />
                  <h2>Your history starts with a real run</h2>
                  <p>
                    No sample results. Run a saved test to see its outcome here.
                  </p>
                </div>
              ) : (
                state.runs.map((run) => (
                  <button
                    className="list-row run-link"
                    onClick={() => openRun(run.id)}
                    key={run.id}
                  >
                    <div>
                      <h3>{run.title}</h3>
                      <p>
                        {date(run.started_at)} ·{" "}
                        {run.replay
                          ? "Deterministic replay"
                          : "First execution"}{" "}
                        · {run.environment_id === "lawcus" ? "Lawcus staging" : "Local test application"}
                      </p>
                    </div>
                    <div className="inline">
                      <Badge className={"status " + run.status}>
                        {run.status}
                      </Badge>
                      <ChevronRight size={17} />
                    </div>
                  </button>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="proposals">
            <div className="panel question-panel">
              <span className="section-label">PROPOSAL INBOX</span>
              {!pendingProposals.length ? (
                <div className="empty-small">
                  <Inbox />
                  <h2>No proposals waiting</h2>
                  <p>
                    When a run finds a candidate locator or another
                    change worth considering, it will appear here for
                    approval — never applied automatically.
                  </p>
                </div>
              ) : (
                pendingProposals.map((p) => (
                  <div className="question" key={p.id}>
                    <div className="inline">
                      <Badge variant="outline">
                        {p.type.replaceAll("_", " ")}
                      </Badge>
                      <Badge variant="outline">{p.risk} risk</Badge>
                      {p.confidence != null && (
                        <span className="subtle">
                          {Math.round(p.confidence * 100)}% confidence
                        </span>
                      )}
                    </div>
                    <p>{p.summary}</p>
                    <p className="subtle">{p.trigger}</p>
                    <p className="subtle">
                      {p.subject_kind} · {p.subject_id} ·{" "}
                      {p.current_value
                        ? `currently “${p.current_value}”`
                        : "no trusted value yet"}{" "}
                      → proposed “{p.proposed_value}”
                    </p>
                    <label className="sr-only" htmlFor={"note-" + p.id}>
                      Decision note
                    </label>
                    <Textarea
                      id={"note-" + p.id}
                      value={notes[p.id] || ""}
                      onChange={(e) =>
                        setNotes({ ...notes, [p.id]: e.target.value })
                      }
                      placeholder="Optional note explaining your decision…"
                      maxLength={1000}
                    />
                    <div className="inline">
                      <Button disabled={busy} onClick={() => decide(p.id, "approve")}>
                        <Check />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => decide(p.id, "reject")}
                      >
                        <X />
                        Reject
                      </Button>
                    </div>
                    <p className="small-note">
                      Requires {p.required_approver_role} approval · raised by{" "}
                      {p.generated_by} · expires {date(p.expires_at)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="safety">
            <div className="safety-grid">
              <div className="panel">
                <span className="section-label">ENFORCED IN THIS VERSION</span>
                <h2>Boundaries before autonomy</h2>
                {[
                  "Only the local fixture and your authorized Lawcus staging target can execute.",
                  "Staging uses a proxy restricted to known public staging hosts. Service workers and WebSockets are blocked.",
                  "Expected business behavior stays unchanged when a test fails.",
                  "Ambiguous login controls stop execution instead of guessing.",
                  "Each check uses a fresh browser session, with no automatic retries.",
                  "Staging evidence is encrypted locally. Downloads require a local session and produce decrypted copies. Screenshots mask input fields.",
                  "A single active run limits collisions and repeated login attempts.",
                ].map((s) => (
                  <div className="safety-row" key={s}>
                    <ShieldCheck size={17} />
                    <p>{s}</p>
                  </div>
                ))}
              </div>
              <div className="panel">
                <span className="section-label">BEFORE BROADER RELEASE</span>
                <h2>Remaining coverage and security work</h2>
                <p className="subtle">
                  This version covers bounded login checks on one Mac. Passing those checks does not establish complete security coverage.
                </p>
                {[
                  "Verify the login contract and least-privilege account permissions",
                  "Verify dedicated account privileges and account lockout policy",
                  "Add OS-enforced network isolation for hosted workers",
                  "Add SSO, role permissions and tenant isolation",
                  "Add automatic evidence retention and secure deletion controls",
                  "Complete dependency review and independent security testing",
                ].map((s, i) => (
                  <div className="safety-row" key={s}>
                    <span className="step-number">{i + 1}</span>
                    <p>{s}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel question-panel">
              <span className="section-label">HUMAN CLARIFICATION</span>
              <h2>Keep business decisions explicit</h2>
              {!questions.length ? (
                <p className="subtle">
                  No open questions. Potential behavior changes will appear
                  here.
                </p>
              ) : (
                questions.map((q) => (
                  <div className="question" key={q.id}>
                    <p>{q.question}</p>
                    <label className="sr-only" htmlFor={q.id}>
                      Explain the expected behavior
                    </label>
                    <Textarea
                      id={q.id}
                      value={answers[q.id] || ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [q.id]: e.target.value })
                      }
                      placeholder="Explain what the expected behavior should be…"
                      maxLength={1000}
                    />
                    <Button
                      disabled={busy || (answers[q.id] || "").trim().length < 3}
                      onClick={() =>
                        action(async () => {
                          const result = await request(
                            "/clarifications/" + q.id,
                            { answer: answers[q.id] },
                          );
                          setMessage(result.message);
                          await refresh();
                        })
                      }
                    >
                      Record clarification
                    </Button>
                    <p className="small-note">
                      This version records your answer. It does not
                      automatically change expectations.
                    </p>
                  </div>
                ))
              )}
            </div>
            <div className="panel question-panel">
              <span className="section-label">AUDIT HISTORY</span>
              {state?.audit.length ? (
                state.audit.map((a) => (
                  <div className="audit-row" key={a.id}>
                    <span>{a.action.replaceAll(".", " · ")}</span>
                    <time>{date(a.created_at)}</time>
                  </div>
                ))
              ) : (
                <p className="subtle">
                  Actions will be recorded as you create and run tests.
                </p>
              )}
            </div>
          </TabsContent>
          <TabsContent value="environment">
            <SecureSetup/>
            <div className="environment-grid">
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-label">REQUESTED TARGET</span>
                    <h2>Lawcus staging</h2>
                  </div>
                  <Badge variant="outline">Staging confirmed</Badge>
                </div>
                <div className="url-field">
                  <Globe size={18} />
                  https://lohith.fiveriverz.com
                </div>
                <p className="subtle">
                  You confirmed this is staging, a dedicated test account is available, and login requires no MFA, SSO or CAPTCHA. Connection status is shown above; actual outcomes appear in Run history.
                </p>
                <div className="notice">
                  <LockKeyhole size={18} />
                  <span>
                    Save your staging account and check the browser connection above. Standard login checks work without an API key; English planning requires OpenAI API access.
                  </span>
                </div>
                <h3>What is needed next</h3>
                <ol className="next-steps">
                  <li>Staging environment: confirmed by you.</li>
                  <li>
                    Dedicated QA account: available; permissions still to verify.
                  </li>
                  <li>No MFA, SSO or CAPTCHA: confirmed by you.</li>
                  <li>
                    Keep the launcher window open while tests are running.
                  </li>
                </ol>
                <p className="small-note">
                  Do not put passwords in test requests or clarification
                  answers. Use only the secure fields above.
                </p>
              </div>
              <div className="scope-card">
                <FlaskConical size={26} />
                <h2>Local test application</h2>
                <Badge variant="outline">Available for platform checks</Badge>
                <p>
                  An isolated login fixture with a synthetic account, protected
                  workspace and sign-out flow.
                </p>
                <p>
                  Use it to verify plan creation, browser execution, evidence,
                  replay and failure handling.
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEnvironment("fixture");
                    setTab("workspace");
                  }}
                >
                  Test the local application
                  <ArrowUpRight />
                </Button>
              </div>
            </div>
          </TabsContent>
          <footer>
            <span>
              Lawcus QA Agent <span className="footer-divider">/</span> Intent
              in. Evidence out.
            </span>
            <span>Local V1 · Bounded login testing</span>
          </footer>
        </main>
      </Tabs>
    </div>
  );
}
