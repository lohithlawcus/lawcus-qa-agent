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
  Lightbulb,
  Network,
  Webhook,
  Waypoints,
  Users,
  Video,
  Cpu,
  Power,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
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
  cleanup_status: string | null;
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
  automationReadiness?: string;
  quarantineReason?: string | null;
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
type KnowledgeItem = {
  id: string;
  semantic_id: string;
  version: number;
  type: string;
  feature_name: string;
  title: string;
  statement: string;
  does_not_mean: string | null;
  provenance: string;
  source_id: string | null;
  status: string;
  created_at: string;
  applies_to: string[] | null;
  preconditions: string[] | null;
  expected_behavior: Record<string, Record<string, string>> | null;
  effective_from: string | null;
  effective_until: string | null;
  release: string | null;
  api_contracts: string[];
  related_tests: string[];
};
type KnowledgeEdge = {
  id: string;
  type: string;
  from_feature: string;
  to_feature: string;
  rationale: string;
  status: string;
};
type KnowledgeFeatureGroup = { feature: string; items: KnowledgeItem[] };
type ApiContract = {
  id: string;
  semantic_id: string;
  version: number;
  feature_name: string;
  operation: string;
  method: string;
  path_template: string;
  read_write: string;
  provenance: string;
  status: string;
  verification_requirements: string;
};
type ApiContractFeatureGroup = { feature: string; items: ApiContract[] };
type EnvironmentAdapter = {
  id: string;
  environment_id: string;
  version: number;
  api_origin: string;
  app_origin: string;
  assets_origin: string | null;
  status: string;
};
type NetworkAuthorityRow = {
  id: string;
  environment_id: string;
  version: number;
  allowed_hosts: string;
  allowed_methods: string;
  allow_redirects: number;
  status: string;
};
type OwnedRecord = {
  id: string;
  run_id: string;
  resource_type: string;
  resource_id: string;
  display_name: string | null;
  cleanup_policy: string;
  cleanup_status: string;
  cleanup_note: string | null;
  openUrl: string | null;
  created_at: string;
};
// Still sitting in staging and waiting on a person. Mirrors the server's
// definition (resource-ownership.mjs): "retain" was decided on purpose,
// "cleaned"/"already_missing" are done.
const isLeftover = (r: OwnedRecord) =>
  r.cleanup_policy !== "retain" && ["pending", "failed", "skipped"].includes(r.cleanup_status);
type State = {
  leftovers: OwnedRecord[];
  environments: { id: string; name: string; url: string; kind: string; execution_enabled: number }[];
  environmentConfirmations: {
    environmentId: string;
    facts: { staging: boolean; dedicatedAccountAvailable: boolean; mfa: boolean; sso: boolean; captcha: boolean };
  }[];
  runbooks: Book[];
  runs: Run[];
  clarifications: Question[];
  proposals: Proposal[];
  testbook: Feature[];
  knowledgeInbox: { items: KnowledgeItem[]; edges: KnowledgeEdge[] };
  knowledgeApproved: KnowledgeFeatureGroup[];
  apiContractsInbox: ApiContract[];
  apiContractsApproved: ApiContractFeatureGroup[];
  environmentAdaptersInbox: EnvironmentAdapter[];
  environmentAdaptersApproved: EnvironmentAdapter[];
  networkAuthoritiesInbox: NetworkAuthorityRow[];
  networkAuthoritiesApproved: NetworkAuthorityRow[];
  personas: Persona[];
  authoringSessions: AuthoringSession[];
  audit: { id: string; action: string; created_at: string }[];
  planner: string;
  aiUsage: AiUsageSummary;
};
type AiUsageSummary = {
  since: string;
  aiEnabled: boolean;
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  byTask: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  totalRuns: number;
  runsUsingAi: number;
  recent: {
    id: string;
    task: string;
    category: string;
    allowed: number;
    reason: string;
    requester: string;
    error_code: string | null;
    created_at: string;
  }[];
};
type Manifest = {
  version: number;
  environmentId: string;
  requestedIntent: string;
  requester: string;
  triggerSource: string;
  runnerRevision: string | null;
  testCases: { scenario: string; externalId: string; version: number }[];
  primitives: { id: string; version: number }[];
  createdAt: string;
};
type NetworkObservation = {
  id: string;
  scenario_result_id: string | null;
  semantic_id: string;
  expected_cardinality: string;
  observed_count: number;
  cardinality_ok: number;
  contract_match: number;
  mismatch_reason: string | null;
};
type ConsoleObservation = {
  id: string;
  scenario_result_id: string | null;
  level: string;
  message: string;
};
type Persona = {
  id: string;
  environment_id: string;
  role: string;
  label: string;
  credential_account: string;
  expected_username: string | null;
  status: string;
  session_status: string;
  created_at: string;
};
type AuthoringSession = {
  id: string;
  operator: string;
  environment_id: string;
  persona_id: string | null;
  feature_name: string;
  workflow_description: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  proposal_ids: string | null;
  discard_reason: string | null;
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
    failure_class?: "functional" | "infrastructure" | "automation" | "integrity" | "unclassified" | null;
    reason_code?: string | null;
  }[];
  artifacts: { id: string; scenario_result_id: string; kind: string }[];
  clarifications: Question[];
  manifest: Manifest | null;
  cancellable: boolean;
  resourceOwnership: OwnedRecord[];
  networkObservations: NetworkObservation[];
  consoleObservations: ConsoleObservation[];
};
type Plan = {
  id: string;
  title: string;
  scenarios: { key: string; title: string; expected: string }[];
  source: string;
};
type ImpactedCell = {
  featureName: string;
  recordState: string;
  externalId: string;
  covered: boolean;
  blockedReason?: string | null;
  testCaseId: string | null;
  currentVersion: number | null;
  executed?: boolean;
  status?: string;
  actual?: string;
  retried?: boolean;
};
type ImpactedPlan = {
  normalizedIntent: string;
  matched: boolean;
  subjectFeatureName?: string;
  features: string[];
  knowledgeItems: { id: string; semantic_id: string; title: string }[];
  cells: ImpactedCell[];
  gaps: ImpactedCell[];
};
type ImpactedRunResult = {
  runId?: string;
  plan: ImpactedPlan;
  results: ImpactedCell[];
  filedProposals: { id: string; summary: string }[];
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
const EXAMPLE_KNOWLEDGE_TEXT = `## Feature: Billing
Description: Invoicing, time entries and payments for a matter.

### BUSINESS_RULE: BR-BILLING-EXAMPLE-001
Title: An invoice needs at least one timekeeper on the matter
Provenance: DOCUMENTED
Statement: A matter must have at least one timekeeper assigned before an invoice can be generated for it.
Applies To: existing_matter

### EDGE: DEPENDS_ON
From: Billing
To: Contacts
Rationale: An invoice is always billed to a Contact record.
`;
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
  const [personaConnection, setPersonaConnection] = useState<{ status: string; message: string } | null>(null);
  const [personaForm, setPersonaForm] = useState({ role: "admin", label: "", credentialAccount: "lawcus-persona-admin" });
  const [authoringForm, setAuthoringForm] = useState({ environmentId: "fixture", featureName: "", workflowDescription: "" });
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importErrors, setImportErrors] = useState<{ line: number; message: string }[]>([]);
  const [importResult, setImportResult] = useState<{ items: number; edges: number } | null>(null);
  const [activeAuthoringSession, setActiveAuthoringSession] = useState<AuthoringSession | null>(null);
  const [authoringLiveCount, setAuthoringLiveCount] = useState(0);
  const [impactedPlan, setImpactedPlan] = useState<ImpactedPlan | null>(null);
  const [impactedResult, setImpactedResult] = useState<ImpactedRunResult | null>(null);
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
      // The notice renders at the very top of the page. A rejection like
      // "a test is already running" comes back almost instantly, and the
      // button itself gives no other feedback — if the user has scrolled
      // down to review a plan (the normal flow before clicking Run), the
      // notice lands off-screen and it looks like the click did nothing.
      window.scrollTo({ top: 0, behavior: "smooth" });
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
      setImpactedPlan(null);
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
      await refresh();
    });
  }
  async function runImpacted() {
    await action(async () => {
      const result = await request<ImpactedRunResult>("/impacted-tests/run", { intent });
      setImpactedResult(result);
      setImpactedPlan(result.plan);
      await refresh();
    });
  }
  // One box, one action: try what's already proven and coverage-aware
  // first — the Impact Graph pattern match, zero AI, real feature reach —
  // and only fall through to the login planner (local intent match, then
  // a bounded AI call as a last resort) when that doesn't recognize the
  // prompt. Impacted-testing cases are staging-only, so skip straight to
  // the login planner for the local fixture environment.
  async function buildPlan() {
    await action(async () => {
      setPlan(null);
      setDetail(null);
      setImpactedPlan(null);
      setImpactedResult(null);
      if (environment === "lawcus") {
        const ip = await request<ImpactedPlan>("/impacted-tests/plan", { intent });
        if (ip.matched) {
          setImpactedPlan(ip);
          await refresh();
          return;
        }
      }
      const p = await request<Plan>("/plans", { intent, planner: "ai", environmentId: environment });
      setPlan(p);
      await refresh();
    });
  }
  async function runPlan() {
    if (impactedPlan?.matched) await runImpacted();
    else if (plan) await runTest(plan.id);
  }
  async function toggleAiGate(enabled: boolean) {
    await action(async () => {
      await request("/ai-gate/toggle", { enabled });
      await refresh();
    });
  }
  async function openRun(id: string) {
    await action(async () => {
      setDetail(await request<Detail>("/runs/" + id));
      setPlan(null);
      setImpactedPlan(null);
      setTab("workspace");
    });
  }
  async function cancelRun(id: string) {
    await action(async () => {
      await request(`/runs/${id}/cancel`, {});
      setMessage(
        "Cancellation requested. The check in progress finishes; the rest are skipped.",
      );
      if (detail?.id === id) setDetail(await request<Detail>("/runs/" + id));
      await refresh();
    });
  }
  async function resolveLeftover(id: string, verb: "removed" | "keep") {
    await action(async () => {
      await request(`/leftovers/${id}/resolve`, { action: verb });
      setMessage(
        verb === "removed"
          ? "Recorded as removed. Nothing was deleted by this app."
          : "Recorded as kept on purpose.",
      );
      if (detail) setDetail(await request<Detail>("/runs/" + detail.id));
      await refresh();
    });
  }
  function renderOwned(rows: OwnedRecord[], heading: string, note: string) {
    return (
      <div className="panel question-panel" data-testid="owned-records">
        <span className="section-label">{heading}</span>
        <p className="subtle">{note}</p>
        {rows.map((r) => (
          <div className="list-row" key={r.id}>
            <div>
              <h3>{r.display_name ?? r.resource_id}</h3>
              <p className="subtle">
                {r.resource_type.replaceAll("_", " ")} · {date(r.created_at)}
                {r.cleanup_note ? ` · ${r.cleanup_note}` : ""}
              </p>
              {r.openUrl && (
                <a href={r.openUrl} target="_blank" rel="noreferrer">
                  Open in Lawcus
                </a>
              )}
            </div>
            <div className="inline">
              {isLeftover(r) ? (
                <>
                  <Badge className="status failed" variant="outline">
                    still in staging
                  </Badge>
                  <Button variant="outline" onClick={() => resolveLeftover(r.id, "removed")}>
                    I removed it
                  </Button>
                  <Button variant="outline" onClick={() => resolveLeftover(r.id, "keep")}>
                    Keep it
                  </Button>
                </>
              ) : (
                <Badge variant="outline">
                  {r.cleanup_policy === "retain" ? "kept on purpose" : "removed"}
                </Badge>
              )}
            </div>
          </div>
        ))}
      </div>
    );
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
  async function decideKnowledge(
    kind: "items" | "edges",
    id: string,
    verb: "approve" | "reject",
  ) {
    await action(async () => {
      const noteKey = `k-${id}`;
      const note = (notes[noteKey] || "").trim();
      await request(`/knowledge/${kind}/${id}/${verb}`, note ? { note } : {});
      setNotes((n) => {
        const next = { ...n };
        delete next[noteKey];
        return next;
      });
      setMessage(
        verb === "approve"
          ? "Knowledge approved. It now appears as trusted for this feature."
          : "Knowledge rejected. It will not become trusted.",
      );
      await refresh();
    });
  }
  async function importKnowledge(retry = true): Promise<void> {
    setImportBusy(true);
    setImportErrors([]);
    setImportResult(null);
    try {
      const res = await fetch(API + "/knowledge/import", {
        method: "POST",
        credentials: "include",
        headers: { "X-QA-Client": "lawcus-workspace", "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      if (res.status === 401 && retry) {
        await request("/session", {});
        return importKnowledge(false);
      }
      const data = (await res.json()) as {
        proposed?: { items: { semanticId: string; version: number }[]; edges: number };
        errors?: { line: number; message: string }[];
        error?: string;
      };
      if (!res.ok) {
        setImportErrors(data.errors?.length ? data.errors : [{ line: 0, message: data.error || "Import failed." }]);
        return;
      }
      if (data.proposed) {
        setImportResult({ items: data.proposed.items.length, edges: data.proposed.edges });
        setImportText("");
        await refresh();
      }
    } catch (e) {
      setImportErrors([{ line: 0, message: e instanceof Error ? e.message : "Import failed." }]);
    } finally {
      setImportBusy(false);
    }
  }
  async function decideApiRecord(
    kind: "api-contracts" | "environment-adapters" | "network-authorities",
    id: string,
    verb: "approve" | "reject",
  ) {
    await action(async () => {
      const noteKey = `${kind}-${id}`;
      const note = (notes[noteKey] || "").trim();
      await request(`/${kind}/${id}/${verb}`, note ? { note } : {});
      setNotes((n) => {
        const next = { ...n };
        delete next[noteKey];
        return next;
      });
      setMessage(
        verb === "approve"
          ? "Approved. It is now part of the trusted, currently-authorized configuration."
          : "Rejected. It will not become trusted.",
      );
      await refresh();
    });
  }
  async function verifyLoginContract() {
    await action(async () => {
      const result = await request<{ status: number; contractMatch: boolean; mismatchReason: string | null }>(
        "/api-contracts/verify-login",
        {},
      );
      setMessage(
        result.contractMatch
          ? `Verified against real staging: HTTP ${result.status} matched the approved contract.`
          : `Real staging call completed (HTTP ${result.status}) but did not match the approved contract: ${result.mismatchReason}`,
      );
      await refresh();
    });
  }
  async function registerPersona() {
    await action(async () => {
      if (!personaForm.label.trim()) throw new Error("Give this persona a label.");
      await request("/personas", { environmentId: "lawcus", ...personaForm });
      setPersonaForm({ role: "admin", label: "", credentialAccount: "lawcus-persona-admin" });
      setMessage("Persona registered. It stays unusable until verified by visible sign-in.");
      await refresh();
    });
  }
  async function verifyPersona(id: string) {
    await action(async () => {
      const value = await request<{ status: string; message: string }>(`/personas/${id}/verify`, {});
      setPersonaConnection({ status: value.status || "failed", message: value.message || "" });
    });
  }
  async function cancelPersonaVerify() {
    await request("/personas/verify/cancel", {});
  }
  async function revokePersona(id: string) {
    await action(async () => {
      await request(`/personas/${id}/revoke`, {});
      setMessage("Persona revoked. It must be re-verified before use.");
      await refresh();
    });
  }
  useEffect(() => {
    if (!personaConnection || !["starting", "waiting"].includes(personaConnection.status)) return;
    const timer = setInterval(async () => {
      try {
        const value = await request<{ status: string; message: string }>("/personas/verify");
        setPersonaConnection({ status: value.status || "failed", message: value.message || "" });
        if (!["starting", "waiting"].includes(value.status || "")) {
          if (value.status === "passed") {
            setMessage(value.message || "Persona verified.");
            await refresh();
          } else setError(value.message || "Persona sign-in could not be verified.");
        }
      } catch {
        setPersonaConnection(null);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [personaConnection, refresh]);
  async function startAuthoring() {
    await action(async () => {
      if (!authoringForm.featureName.trim() || !authoringForm.workflowDescription.trim())
        throw new Error("Describe the feature and the workflow you'll perform.");
      const session = await request<AuthoringSession>("/authoring/sessions", authoringForm);
      setActiveAuthoringSession(session);
      setAuthoringLiveCount(0);
      setMessage("A separate Chromium window opened — perform the workflow there, then come back and finish.");
    });
  }
  async function finishAuthoring() {
    if (!activeAuthoringSession) return;
    await action(async () => {
      const result = await request<{ proposalCount: number; actionCount: number; proposalErrors: string[] }>(
        `/authoring/sessions/${activeAuthoringSession.id}/complete`,
        {},
      );
      setActiveAuthoringSession(null);
      setMessage(
        `Recorded ${result.actionCount} action(s) — ${result.proposalCount} proposal(s) created for review in Proposals.` +
          (result.proposalErrors.length ? ` (${result.proposalErrors.length} could not be created.)` : ""),
      );
      await refresh();
    });
  }
  async function discardAuthoring() {
    if (!activeAuthoringSession) return;
    await action(async () => {
      await request(`/authoring/sessions/${activeAuthoringSession.id}/discard`, {});
      setActiveAuthoringSession(null);
      setMessage("Recording discarded. No proposals were created.");
      await refresh();
    });
  }
  useEffect(() => {
    if (!activeAuthoringSession) return;
    const timer = setInterval(async () => {
      try {
        const detail = await request<{ live: { actionCount: number } | null }>(`/authoring/sessions/${activeAuthoringSession.id}`);
        if (detail.live) setAuthoringLiveCount(detail.live.actionCount);
      } catch {
        /* transient poll failure — keep the session open, try again next tick */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [activeAuthoringSession]);
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
  const pendingKnowledgeItems = state?.knowledgeInbox.items || [];
  const pendingKnowledgeEdges = state?.knowledgeInbox.edges || [];
  const pendingKnowledgeCount = pendingKnowledgeItems.length + pendingKnowledgeEdges.length;
  const approvedKnowledgeCount = (state?.knowledgeApproved || []).reduce(
    (sum, group) => sum + group.items.length,
    0,
  );
  const pendingApiContracts = state?.apiContractsInbox || [];
  const pendingEnvironmentAdapters = state?.environmentAdaptersInbox || [];
  const pendingNetworkAuthorities = state?.networkAuthoritiesInbox || [];
  const pendingApiCount =
    pendingApiContracts.length + pendingEnvironmentAdapters.length + pendingNetworkAuthorities.length;
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
          <span className="operator-name">Lohith Reddy</span>
          <div className="avatar" aria-label="Local operator">
            LR
          </div>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="workspace-tabs">
        <div className="nav-wrap">
          <TabsList variant="line" className="top-nav">
            <TabsTrigger value="workspace">
              <Terminal />
              Test
            </TabsTrigger>
            <TabsTrigger value="testbook">
              <ListChecks />
              TestBook
            </TabsTrigger>
            <TabsTrigger value="ai-usage">
              <Cpu />
              AI Usage
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
            <TabsTrigger value="knowledge">
              <Lightbulb />
              Knowledge
              {pendingKnowledgeCount > 0 && (
                <Badge variant="outline">{pendingKnowledgeCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="api">
              <Webhook />
              API Contracts
              {pendingApiCount > 0 && <Badge variant="outline">{pendingApiCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="personas">
              <Users />
              Personas
            </TabsTrigger>
            <TabsTrigger value="teach">
              <Video />
              Teach / Record
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
                  ? "Ask in plain English. Get a clear plan. Run what's proven."
                  : tab === "testbook"
                    ? "The record of what's actually proven"
                    : tab === "ai-usage"
                        ? "Known work costs zero model calls"
                        : tab === "history"
                        ? "Every run, accounted for"
                        : tab === "proposals"
                          ? "Nothing changes without your say"
                          : tab === "knowledge"
                            ? "Observed is evidence. Approved is truth."
                            : tab === "api"
                              ? "What an endpoint should do, and where it may be called"
                              : tab === "personas"
                                ? "Verified is signed in for real. Nothing else counts."
                                : tab === "teach"
                                  ? "Perform it once. Review turns it into a test."
                                  : tab === "safety"
                                    ? "Confidence needs evidence"
                                    : "Connect your test environment"}
              </h1>
              <p>
                {tab === "workspace"
                  ? "One box for everything you can test — login, Contacts, Leads, and what they affect downstream."
                  : tab === "testbook"
                    ? "Feature → suite → test case, each on a versioned definition, with its real execution history."
                    : tab === "ai-usage"
                        ? "Every model call is logged, permitted only by policy, and never the normal way this system runs."
                        : tab === "history"
                        ? "Results and evidence are retained, including failed and interrupted runs."
                        : tab === "proposals"
                          ? "A candidate change to a locator or test never applies itself. Review the evidence, then approve or reject."
                          : tab === "knowledge"
                            ? "Every rule below cites its source. Nothing becomes trusted product truth until you approve it."
                            : tab === "api"
                              ? "A contract, its environment, and its network authority are approved separately. All three are required before any real call runs."
                              : tab === "personas"
                                ? "A persona only becomes usable after a real, visible sign-in confirms its identity — never a saved claim."
                                : tab === "teach"
                                  ? "A visible Chromium window opens for you to demonstrate the workflow. Nothing recorded is trusted or executed automatically — it only ever becomes a proposal."
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
                        ? "Local-first · AI-assisted fallback"
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
                        setImpactedPlan(null);
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
                        {(state?.environments || []).map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.kind === "fixture" ? "Local test application" : e.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      className="primary-button"
                      disabled={!intent.trim() || busy || !state}
                      onClick={() => buildPlan()}
                    >
                      {busy ? (
                        <LoaderCircle className="spin" />
                      ) : (
                        <ArrowUpRight />
                      )}
                      Build plan
                    </Button>
                  </div>
                </div>
                {environment === "lawcus" && <div className="try-row"><Button variant="outline" disabled={busy || !state} onClick={() => planTest("standard")}>Use standard login checks</Button><span>Four fixed checks · No API key needed · Review before running</span></div>}
                <div className="try-row">
                  <span>Try a request</span>
                  {[
                    "Test the login page.",
                    "Update a contact custom field and check how it appears for existing/new Contact and Lead.",
                    "Thoroughly test login.",
                  ].map((text) => (
                    <button key={text} onClick={() => setIntent(text)}>
                      {text}
                      <ChevronRight size={13} />
                    </button>
                  ))}
                </div>
                {detail ? (
                  <div className="panel result-panel">
                    <div className="panel-heading">
                      <div>
                        <span className="section-label">RUN REPORT</span>
                        <h2>{detail.title}</h2>
                      </div>
                      <div className="inline">
                        {detail.status === "running" && detail.cancellable && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => cancelRun(detail.id)}
                          >
                            <X size={14} />
                            Cancel
                          </Button>
                        )}
                        <Badge className={"status " + detail.status}>
                          {detail.status === "running" ? (
                            <LoaderCircle className="spin" />
                          ) : detail.status === "passed" ? (
                            <Check />
                          ) : detail.status === "cancelled" ? (
                            <X />
                          ) : (
                            <AlertTriangle />
                          )}
                          {detail.status.replaceAll("_", " ")}
                        </Badge>
                        {detail.cleanup_status && (
                          <Badge variant="outline" className={"status " + detail.cleanup_status}>
                            cleanup: {detail.cleanup_status.replaceAll("_", " ")}
                          </Badge>
                        )}
                      </div>
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
                    {detail.resourceOwnership?.length > 0 &&
                      renderOwned(
                        detail.resourceOwnership,
                        "RECORDS THIS RUN CREATED",
                        "This app never deletes anything from Lawcus. Remove any that are still there yourself, then mark them here.",
                      )}
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
                            {r.status !== "passed" && r.failure_class && r.failure_class !== "functional" && (
                              <p className="small-note">
                                <Badge variant="outline">
                                  {r.failure_class === "infrastructure"
                                    ? "Environment or tooling problem"
                                    : r.failure_class === "automation"
                                      ? "The check could not drive the page"
                                      : r.failure_class === "integrity"
                                        ? "A record or evidence could not be saved"
                                        : "Unrecognised error, needs a look"}
                                </Badge>{" "}
                                This does not show that Lawcus itself is wrong.
                                {r.reason_code ? ` (${r.reason_code})` : ""}
                              </p>
                            )}
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
                            {detail.networkObservations
                              .filter((n) => n.scenario_result_id === r.id)
                              .map((n) => (
                                <div className="inline" key={n.id}>
                                  <Webhook size={13} />
                                  <Badge variant="outline">
                                    {n.contract_match ? "Network contract verified" : "Network contract mismatch"}
                                  </Badge>
                                  {!n.contract_match && n.mismatch_reason && (
                                    <span className="subtle">{n.mismatch_reason}</span>
                                  )}
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {detail.consoleObservations.length > 0 && (
                      <div className="small-note">
                        {detail.consoleObservations.length} browser console/page error(s) captured
                        {" — "}
                        {Object.entries(
                          detail.consoleObservations.reduce<Record<string, number>>((counts, c) => {
                            counts[c.message] = (counts[c.message] || 0) + 1;
                            return counts;
                          }, {}),
                        )
                          .map(([message, count]) => (count > 1 ? `${message} (×${count})` : message))
                          .join(" · ")}
                      </div>
                    )}
                    {detail.manifest && (
                      <div className="small-note">
                        Exact versions used: {detail.manifest.testCases
                          .map((c) => `${c.externalId} v${c.version}`)
                          .join(", ")}{" "}
                        · primitives{" "}
                        {detail.manifest.primitives
                          .map((p) => `${p.id} v${p.version}`)
                          .join(", ")}
                        {detail.manifest.runnerRevision
                          ? ` · runner ${detail.manifest.runnerRevision}`
                          : ""}{" "}
                        · requested by {detail.manifest.requester}
                      </div>
                    )}
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
                ) : impactedPlan?.matched ? (
                  <div className="panel">
                    <div className="panel-heading">
                      <div>
                        <span className="section-label">READY FOR REVIEW</span>
                        <h2>{impactedPlan.subjectFeatureName} impact</h2>
                      </div>
                      <Badge variant="outline">
                        {impactedPlan.cells.length} checks
                      </Badge>
                    </div>
                    <p className="subtle">
                      Recognized locally — matched to approved coverage across
                      the Impact Graph, without an AI call.
                    </p>
                    <div className="inline">
                      {impactedPlan.features.map((f) => (
                        <Badge key={f} variant="outline">
                          {f}
                        </Badge>
                      ))}
                    </div>
                    <div className="scenario-list">
                      {impactedPlan.cells.map((cell) => {
                        const executed = impactedResult?.results.find(
                          (r) => r.externalId === cell.externalId,
                        );
                        return (
                          <div className="list-row" key={cell.externalId}>
                            <div>
                              <h3>
                                {cell.featureName} — {cell.recordState} record
                              </h3>
                              <p className="subtle">{cell.externalId}</p>
                              {executed?.actual && (
                                <p className="small-note">{executed.actual}</p>
                              )}
                            </div>
                            <Badge
                              className={executed ? "status " + executed.status : ""}
                              variant="outline"
                            >
                              {executed
                                ? executed.status
                                : cell.covered
                                  ? "approved · not run yet"
                                  : cell.blockedReason === "quarantined"
                                    ? "quarantined"
                                    : "needs review"}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                    {impactedResult && impactedResult.filedProposals.length > 0 && (
                      <p className="subtle">
                        {impactedResult.filedProposals.length} NEW_TEST
                        proposal(s) filed for review in the Proposals tab —
                        nothing runs for an unapproved cell.
                      </p>
                    )}
                    <div className="plan-bottom">
                      <span>
                        <LockKeyhole size={14} /> Dedicated staging account
                      </span>
                      <Button
                        className="primary-button"
                        disabled={busy || running}
                        onClick={() => runPlan()}
                      >
                        <Play />
                        Run {impactedPlan.cells.length} checks
                      </Button>
                    </div>
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
                      {environment === "lawcus"
                        ? `Review these staging expectations before running. ${
                            plan.source === "standard"
                              ? "This is a fixed plan created without AI."
                              : plan.source === "intent-router"
                                ? "Recognized as a known request — matched to approved coverage locally, without an AI call."
                                : "OpenAI selected checks from the bounded login contract."
                          }`
                        : "These checks use the synthetic local login contract."}
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
                      Your request becomes readable checks against what&apos;s
                      already proven, then repeatable browser steps. Try the
                      login page, or ask what a Contacts or Leads change
                      affects.
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
                  <h2>Coverage-aware testing</h2>
                  <p>
                    {environment === "lawcus" ? "Checks real coverage across features first, then falls back to a bounded, login-only AI plan when nothing local matches." : "Test the QA platform against its local synthetic application."}
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
                    <Accordion type="multiple">
                      {feature.suites.map((suite) => (
                        <AccordionItem key={suite.id} value={suite.id}>
                          <AccordionTrigger>
                            <div>
                              <h3>{suite.name}</h3>
                              <span className="subtle">
                                {suite.cases.length} test case
                                {suite.cases.length === 1 ? "" : "s"}
                              </span>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent>
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
                                    {testCase.automationReadiness === "quarantined" && (
                                      <Badge
                                        className="status failed"
                                        variant="outline"
                                        title={testCase.quarantineReason ?? undefined}
                                      >
                                        quarantined — not counted as coverage
                                      </Badge>
                                    )}
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
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="ai-usage">
            <div className="panel">
              <span className="section-label">KILL SWITCH</span>
              <div className="list-row">
                <div>
                  <h3>{state?.aiUsage.aiEnabled ? "AI Enabled" : "AI Disabled"}</h3>
                  <p className="subtle">
                    {state?.aiUsage.aiEnabled
                      ? "AI may be used only for genuinely novel prompts the local router can't resolve. Known regression never reaches it."
                      : "AI is fully disabled. An unrecognized prompt returns an error instead of calling a model."}
                  </p>
                </div>
                <Button
                  variant={state?.aiUsage.aiEnabled ? "outline" : undefined}
                  disabled={busy}
                  onClick={() => toggleAiGate(!state?.aiUsage.aiEnabled)}
                >
                  <Power />
                  {state?.aiUsage.aiEnabled ? "Disable AI" : "Enable AI"}
                </Button>
              </div>
            </div>
            <div className="panel">
              <span className="section-label">LAST 24 HOURS</span>
              <div className="inline">
                <Badge variant="outline">{state?.aiUsage.totalRuns ?? 0} runs total</Badge>
                <Badge variant="outline">{state?.aiUsage.runsUsingAi ?? 0} used AI</Badge>
                <Badge variant="outline">{state?.aiUsage.allowedRequests ?? 0} AI calls allowed</Badge>
                <Badge variant="outline">{state?.aiUsage.blockedRequests ?? 0} refused</Badge>
                <Badge variant="outline">
                  {(state?.aiUsage.inputTokens ?? 0) + (state?.aiUsage.outputTokens ?? 0)} tokens
                </Badge>
              </div>
            </div>
            <div className="panel">
              <span className="section-label">RECENT REQUESTS</span>
              {!state?.aiUsage.recent.length ? (
                <div className="empty-small">
                  <Cpu />
                  <h2>No AI requests in this window</h2>
                  <p>Known prompts and known regression never reach this layer.</p>
                </div>
              ) : (
                state.aiUsage.recent.map((r) => (
                  <div className="list-row" key={r.id}>
                    <div>
                      <h3>
                        {r.task} · {r.category.replaceAll("_", " ")}
                      </h3>
                      <p className="subtle">{r.reason}</p>
                      <span className="subtle">
                        {r.requester} · {date(r.created_at)}
                      </span>
                    </div>
                    <Badge
                      variant="outline"
                      className={"status " + (r.allowed ? "passed" : "failed")}
                    >
                      {r.allowed ? "allowed" : r.error_code ?? "refused"}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          <TabsContent value="history">
            {state?.leftovers?.length
              ? renderOwned(
                  state.leftovers,
                  `RECORDS LEFT IN STAGING (${state.leftovers.length})`,
                  "Created by test runs and still in Lawcus. This app never deletes them: remove them in Lawcus, then mark them here.",
                )
              : null}
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
          <TabsContent value="knowledge">
            <div className="knowledge-summary">
              <div className="knowledge-summary-stat">
                <strong>{pendingKnowledgeCount}</strong>
                <span>Pending review</span>
              </div>
              <div className="knowledge-summary-stat">
                <strong>{approvedKnowledgeCount}</strong>
                <span>Approved</span>
              </div>
            </div>
            <div className="panel question-panel panel-highlight">
              <div className="panel-heading">
                <span className="section-label">ADD KNOWLEDGE</span>
                <Lightbulb />
              </div>
              <p className="subtle">
                Paste business rules, field rules, dependencies and other Knowledge in one go — each
                one lands in the inbox below as pending review, exactly like a single proposal.
                Nothing here is ever auto-approved.
              </p>
              <Accordion type="single" collapsible className="format-guide">
                <AccordionItem value="format-guide">
                  <AccordionTrigger style={{ padding: "10px 14px" }}>
                    How do I format this?
                  </AccordionTrigger>
                  <AccordionContent style={{ padding: "0 14px 14px" }}>
                    <p className="subtle" style={{ marginBottom: 10 }}>
                      One field per line, no multi-line values. <code>## Feature:</code> starts a
                      group (needs a <code>Description:</code> the first time it appears);{" "}
                      <code>### TYPE: SEMANTIC-ID</code> starts one item;{" "}
                      <code>### EDGE: TYPE</code> links two existing features.
                    </p>
                    <div className="format-guide-example">{EXAMPLE_KNOWLEDGE_TEXT}</div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              <Textarea
                rows={10}
                placeholder={EXAMPLE_KNOWLEDGE_TEXT}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                style={{ marginTop: 12, fontFamily: "monospace", fontSize: 13 }}
              />
              <div className="inline" style={{ marginTop: 12 }}>
                <Button disabled={importBusy || !importText.trim()} onClick={() => void importKnowledge()}>
                  {importBusy ? <LoaderCircle className="spin" /> : <Lightbulb />}
                  Import
                </Button>
                <Button variant="outline" disabled={importBusy} onClick={() => setImportText(EXAMPLE_KNOWLEDGE_TEXT)}>
                  Load example
                </Button>
              </div>
              {importResult && (
                <p className="notice" role="status" style={{ marginTop: 12 }}>
                  Proposed {importResult.items} Knowledge item{importResult.items === 1 ? "" : "s"}
                  {importResult.edges > 0
                    ? ` and ${importResult.edges} relationship${importResult.edges === 1 ? "" : "s"}`
                    : ""}
                  . Review {importResult.items === 1 ? "it" : "them"} below.
                </p>
              )}
              {importErrors.length > 0 && (
                <div className="notice error" role="alert" style={{ marginTop: 12 }}>
                  <p>Nothing was imported — fix these and try again:</p>
                  <ul>
                    {importErrors.map((err, i) => (
                      <li key={i}>
                        {err.line > 0 ? `Line ${err.line}: ` : ""}
                        {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="panel question-panel">
              <span className="section-label">KNOWLEDGE INBOX</span>
              {!pendingKnowledgeItems.length && !pendingKnowledgeEdges.length ? (
                <div className="empty-small">
                  <Lightbulb />
                  <h2>Nothing waiting for review</h2>
                  <p>
                    Extracted rules and impact-graph relationships land
                    here — never trusted until you approve them.
                  </p>
                </div>
              ) : (
                <>
                  {Object.entries(
                    pendingKnowledgeItems.reduce<Record<string, KnowledgeItem[]>>(
                      (groups, item) => {
                        (groups[item.feature_name] ||= []).push(item);
                        return groups;
                      },
                      {},
                    ),
                  ).map(([featureName, items]) => (
                    <div key={featureName}>
                      <h3>{featureName}</h3>
                      {items.map((k) => (
                        <div className="question" key={k.id}>
                          <div className="inline">
                            <Badge variant="outline">{k.semantic_id}</Badge>
                            <Badge variant="outline">
                              {k.type.replaceAll("_", " ")}
                            </Badge>
                            <Badge variant="outline">{k.provenance}</Badge>
                            {k.applies_to?.map((a) => (
                              <Badge variant="outline" key={a}>
                                {a.replaceAll("_", " ")}
                              </Badge>
                            ))}
                          </div>
                          <p>
                            <strong>{k.title}</strong>
                          </p>
                          <p className="subtle">{k.statement}</p>
                          {k.does_not_mean && (
                            <p className="subtle">
                              Does not mean: {k.does_not_mean}
                            </p>
                          )}
                          {k.preconditions && k.preconditions.length > 0 && (
                            <p className="subtle">
                              Preconditions: {k.preconditions.join("; ")}
                            </p>
                          )}
                          {k.expected_behavior && (
                            <p className="subtle">
                              {Object.entries(k.expected_behavior)
                                .map(
                                  ([state, fields]) =>
                                    `${state.replaceAll("_", " ")}: ${Object.entries(
                                      fields,
                                    )
                                      .map(([f, v]) => `${f}=${v}`)
                                      .join(", ")}`,
                                )
                                .join(" · ")}
                            </p>
                          )}
                          {(k.api_contracts.length > 0 || k.related_tests.length > 0) && (
                            <p className="small-note">
                              {k.api_contracts.length > 0 &&
                                `API: ${k.api_contracts.join(", ")}`}
                              {k.api_contracts.length > 0 && k.related_tests.length > 0 && " · "}
                              {k.related_tests.length > 0 &&
                                `Tests: ${k.related_tests.join(", ")}`}
                            </p>
                          )}
                          <label className="sr-only" htmlFor={"note-k-" + k.id}>
                            Decision note
                          </label>
                          <Textarea
                            id={"note-k-" + k.id}
                            value={notes["k-" + k.id] || ""}
                            onChange={(e) =>
                              setNotes({ ...notes, ["k-" + k.id]: e.target.value })
                            }
                            placeholder="Optional note explaining your decision…"
                            maxLength={1000}
                          />
                          <div className="inline">
                            <Button
                              disabled={busy}
                              onClick={() => decideKnowledge("items", k.id, "approve")}
                            >
                              <Check />
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => decideKnowledge("items", k.id, "reject")}
                            >
                              <X />
                              Reject
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {pendingKnowledgeEdges.length > 0 && (
                    <div>
                      <h3>
                        <Network size={16} /> Impact Graph relationships
                      </h3>
                      {pendingKnowledgeEdges.map((edge) => (
                        <div className="question" key={edge.id}>
                          <p>
                            <strong>{edge.from_feature}</strong>{" "}
                            {edge.type.replaceAll("_", " ").toLowerCase()}{" "}
                            <strong>{edge.to_feature}</strong>
                          </p>
                          <p className="subtle">{edge.rationale}</p>
                          <div className="inline">
                            <Button
                              disabled={busy}
                              onClick={() => decideKnowledge("edges", edge.id, "approve")}
                            >
                              <Check />
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => decideKnowledge("edges", edge.id, "reject")}
                            >
                              <X />
                              Reject
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {state?.knowledgeApproved.length ? (
              <div className="panel question-panel">
                <span className="section-label">APPROVED KNOWLEDGE</span>
                {state.knowledgeApproved.map((group) => (
                  <div key={group.feature}>
                    <h3>{group.feature}</h3>
                    {group.items.map((k) => (
                      <div className="list-row" key={k.id}>
                        <div>
                          <div className="inline">
                            <Badge variant="outline">{k.semantic_id}</Badge>
                            {k.applies_to?.map((a) => (
                              <Badge variant="outline" key={a}>
                                {a.replaceAll("_", " ")}
                              </Badge>
                            ))}
                          </div>
                          <h3>{k.title}</h3>
                          <p className="subtle">{k.statement}</p>
                          {(k.api_contracts.length > 0 || k.related_tests.length > 0) && (
                            <p className="small-note">
                              {k.api_contracts.length > 0 &&
                                `API: ${k.api_contracts.join(", ")}`}
                              {k.api_contracts.length > 0 && k.related_tests.length > 0 && " · "}
                              {k.related_tests.length > 0 &&
                                `Tests: ${k.related_tests.join(", ")}`}
                            </p>
                          )}
                        </div>
                        <Badge variant="outline">v{k.version}</Badge>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="api">
            <div className="panel question-panel">
              <span className="section-label">API CONTRACT INBOX</span>
              {!pendingApiContracts.length ? (
                <div className="empty-small">
                  <Webhook />
                  <h2>Nothing waiting for review</h2>
                  <p>
                    A proposed API contract describes one endpoint&apos;s method, path,
                    request/response shape and provenance — never trusted until you approve it.
                  </p>
                </div>
              ) : (
                pendingApiContracts.map((c) => (
                  <div className="question" key={c.id}>
                    <div className="inline">
                      <Badge variant="outline">{c.method}</Badge>
                      <Badge variant="outline">{c.provenance}</Badge>
                      <Badge variant="outline">{c.read_write}</Badge>
                    </div>
                    <p>
                      <strong>{c.operation}</strong>
                    </p>
                    <p className="subtle">
                      {c.feature_name} · {c.path_template}
                    </p>
                    <p className="subtle">{c.verification_requirements}</p>
                    <label className="sr-only" htmlFor={"note-ac-" + c.id}>
                      Decision note
                    </label>
                    <Textarea
                      id={"note-ac-" + c.id}
                      value={notes["api-contracts-" + c.id] || ""}
                      onChange={(e) =>
                        setNotes({ ...notes, ["api-contracts-" + c.id]: e.target.value })
                      }
                      placeholder="Optional note explaining your decision…"
                      maxLength={1000}
                    />
                    <div className="inline">
                      <Button disabled={busy} onClick={() => decideApiRecord("api-contracts", c.id, "approve")}>
                        <Check />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => decideApiRecord("api-contracts", c.id, "reject")}
                      >
                        <X />
                        Reject
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
            {state?.apiContractsApproved.length ? (
              <div className="panel question-panel">
                <span className="section-label">APPROVED API CONTRACTS</span>
                {state.apiContractsApproved.map((group) => (
                  <div key={group.feature}>
                    <h3>{group.feature}</h3>
                    {group.items.map((c) => (
                      <div className="list-row" key={c.id}>
                        <div>
                          <h3>{c.operation}</h3>
                          <p className="subtle">
                            {c.method} {c.path_template}
                          </p>
                        </div>
                        <Badge variant="outline">v{c.version}</Badge>
                      </div>
                    ))}
                  </div>
                ))}
                <Button variant="outline" disabled={busy} onClick={verifyLoginContract}>
                  <Waypoints />
                  Verify login contract against real staging
                </Button>
                <p className="small-note">
                  Sends one real request to the authorized staging login endpoint with a
                  deliberately wrong password — it can never authenticate — and checks the
                  response against the approved contract.
                </p>
              </div>
            ) : null}
            <div className="environment-grid">
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-label">ENVIRONMENT ADAPTER</span>
                    <h2>Lawcus staging origins</h2>
                  </div>
                </div>
                {pendingEnvironmentAdapters.map((a) => (
                  <div className="question" key={a.id}>
                    <p className="subtle">API origin: {a.api_origin}</p>
                    <p className="subtle">App origin: {a.app_origin}</p>
                    {a.assets_origin && <p className="subtle">Assets origin: {a.assets_origin}</p>}
                    <div className="inline">
                      <Button disabled={busy} onClick={() => decideApiRecord("environment-adapters", a.id, "approve")}>
                        <Check />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => decideApiRecord("environment-adapters", a.id, "reject")}
                      >
                        <X />
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
                {state?.environmentAdaptersApproved.map((a) => (
                  <div className="list-row" key={a.id}>
                    <div>
                      <p className="subtle">{a.api_origin}</p>
                    </div>
                    <Badge variant="outline">approved · v{a.version}</Badge>
                  </div>
                ))}
              </div>
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-label">NETWORK AUTHORITY</span>
                    <h2>What the Safe API Executor may contact</h2>
                  </div>
                </div>
                {pendingNetworkAuthorities.map((n) => (
                  <div className="question" key={n.id}>
                    <p className="subtle">Hosts: {JSON.parse(n.allowed_hosts).join(", ")}</p>
                    <p className="subtle">Methods: {JSON.parse(n.allowed_methods).join(", ")}</p>
                    <p className="subtle">Redirects: {n.allow_redirects ? "allowed" : "blocked"}</p>
                    <div className="inline">
                      <Button disabled={busy} onClick={() => decideApiRecord("network-authorities", n.id, "approve")}>
                        <Check />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => decideApiRecord("network-authorities", n.id, "reject")}
                      >
                        <X />
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
                {state?.networkAuthoritiesApproved.map((n) => (
                  <div className="list-row" key={n.id}>
                    <div>
                      <p className="subtle">{JSON.parse(n.allowed_hosts).join(", ")}</p>
                    </div>
                    <Badge variant="outline">approved · v{n.version}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="personas">
            <div className="panel question-panel">
              <span className="section-label">REGISTER A PERSONA</span>
              <h2>Add a controlled QA identity</h2>
              <p className="subtle">
                Registering only reserves the identity and its Keychain slot. It stays unusable
                until a real, visible sign-in confirms who actually authenticated.
              </p>
              <div className="inline">
                <Select
                  value={personaForm.role}
                  onValueChange={(role) =>
                    setPersonaForm({ role, label: personaForm.label, credentialAccount: `lawcus-persona-${role.replace("_", "-")}` })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="co_counsel">Co-counsel</SelectItem>
                    <SelectItem value="custom">Custom role</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={personaForm.label}
                  onChange={(e) => setPersonaForm({ ...personaForm, label: e.target.value })}
                  placeholder="Label, e.g. “QA Admin”"
                  maxLength={80}
                />
                <Button disabled={busy} onClick={registerPersona}>
                  <Users />
                  Register
                </Button>
              </div>
            </div>
            <div className="panel question-panel">
              <span className="section-label">PERSONAS</span>
              {!state?.personas.length ? (
                <div className="empty-small">
                  <Users />
                  <h2>No personas registered yet</h2>
                  <p>Register one above, then verify it with a real visible sign-in.</p>
                </div>
              ) : (
                state.personas.map((p) => (
                  <div className="question" key={p.id}>
                    <div className="inline">
                      <Badge variant="outline">{p.role.replaceAll("_", " ")}</Badge>
                      <Badge variant="outline">{p.status.replaceAll("_", " ")}</Badge>
                      {p.status === "verified" && <Badge variant="outline">session: {p.session_status}</Badge>}
                    </div>
                    <p>
                      <strong>{p.label}</strong>
                    </p>
                    <p className="subtle">
                      {p.credential_account}
                      {p.expected_username ? ` · ${p.expected_username}` : ""}
                    </p>
                    <div className="inline">
                      {p.status !== "verified" && (
                        <Button disabled={busy} onClick={() => verifyPersona(p.id)}>
                          <ShieldCheck />
                          Verify with visible sign-in
                        </Button>
                      )}
                      {p.status === "verified" && (
                        <Button variant="outline" disabled={busy} onClick={() => revokePersona(p.id)}>
                          <X />
                          Revoke
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
              {personaConnection && ["starting", "waiting"].includes(personaConnection.status) && (
                <div className="question">
                  <p role="status" className="small-note">
                    {personaConnection.message}
                  </p>
                  <Button variant="outline" onClick={cancelPersonaVerify}>
                    Cancel sign-in
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent value="teach">
            {!activeAuthoringSession ? (
              <div className="panel question-panel">
                <span className="section-label">TEACH / RECORD WORKFLOW</span>
                <h2>Show Lawcus QA a workflow by performing it</h2>
                <p className="subtle">
                  A separate, controlled Chromium window opens with the same environment and network
                  policy every trusted run uses. Perform the workflow there yourself — nothing you do
                  is executed automatically or saved as a trusted test. When you finish, it becomes
                  proposals for you to review in Proposals.
                </p>
                <div className="inline">
                  <Select
                    value={authoringForm.environmentId}
                    onValueChange={(environmentId) => setAuthoringForm({ ...authoringForm, environmentId })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixture">Local test application</SelectItem>
                      <SelectItem value="lawcus">Lawcus staging</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  value={authoringForm.featureName}
                  onChange={(e) => setAuthoringForm({ ...authoringForm, featureName: e.target.value })}
                  placeholder="Feature, e.g. “Contacts”"
                  maxLength={80}
                />
                <Textarea
                  value={authoringForm.workflowDescription}
                  onChange={(e) => setAuthoringForm({ ...authoringForm, workflowDescription: e.target.value })}
                  placeholder="Describe the workflow you'll demonstrate, e.g. “Edit a contact's custom field and save”"
                  maxLength={300}
                />
                <Button disabled={busy} onClick={startAuthoring}>
                  <Video />
                  Start recording
                </Button>
              </div>
            ) : (
              <div className="panel question-panel">
                <span className="section-label">RECORDING IN PROGRESS</span>
                <h2>{activeAuthoringSession.feature_name}</h2>
                <p className="subtle">{activeAuthoringSession.workflow_description}</p>
                <p role="status" className="small-note">
                  {authoringLiveCount} action(s) captured so far. Perform the workflow in the separate
                  Chromium window, then come back here.
                </p>
                <div className="inline">
                  <Button disabled={busy} onClick={finishAuthoring}>
                    <Check />
                    Finish & create proposals
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={discardAuthoring}>
                    <X />
                    Discard
                  </Button>
                </div>
              </div>
            )}
            <div className="panel question-panel">
              <span className="section-label">PAST SESSIONS</span>
              {!state?.authoringSessions.length ? (
                <div className="empty-small">
                  <Video />
                  <h2>No recordings yet</h2>
                </div>
              ) : (
                state.authoringSessions.map((s) => (
                  <div className="list-row" key={s.id}>
                    <div>
                      <h3>
                        {s.feature_name} — {s.workflow_description}
                      </h3>
                      <p className="subtle">{date(s.started_at)}</p>
                    </div>
                    <Badge variant="outline">{s.status}</Badge>
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
            <SecureSetup
              environments={state?.environments}
              environmentConfirmations={state?.environmentConfirmations}
            />
            <div className="environment-grid">
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
