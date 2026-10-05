import { randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";
import { ALLOWED_SCENARIOS } from "./schemas/login-plan.mjs";
import { openAiSafety, AI_FAILURE_LIMIT, AI_HOURLY_LIMIT } from "./safety.mjs";

// V5 Upgrade Phase U1 — AI Gate / Intelligence Policy Engine (section 3).
// The single, authoritative choke point for every real external AI
// provider call in this codebase. Wraps the existing ModelRouter (Step 8,
// server/ai/router.mjs) rather than replacing it — router.mjs already
// correctly owns provider/model selection; this layer owns permission,
// auditing, and the operator kill switch, which router.mjs was never
// meant to know about (a call site imports the Gate now, never the
// router directly — the router itself is unchanged).
//
// section 2.3's mandatory "AI_ENABLED = false" mode is a persisted,
// human-toggleable setting (ai_gate_settings, migration 018 — a singleton
// row) rather than a process env var, matching how every other
// operator-facing control in this project works (environments, personas,
// network authority, ...).
//
// section 3.2's task categories: NEVER-tier tasks (known execution,
// replay, CI regression, API/state validation, cleanup, resource
// locking, known intent routing, ...) never reach this module at all —
// they're already handled entirely by deterministic code (intent.mjs,
// impacted-testing.mjs, live-runner.mjs, testbook.mjs, ...) that never
// imports anything from server/ai/. There is no "NEVER" branch to write
// here; the absence of a call site *is* the NEVER enforcement. Only
// ALLOWED_IF_NEEDED-tier tasks get a category below — the exact same set
// TASK_POLICY in router.mjs already lists (one entry today: planLogin).
export const TASK_CATEGORIES = {
  planLogin: "AMBIGUITY_ANALYSIS",
};

export class AiGateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Mirrors proposals.mjs/knowledge.mjs's own NON_HUMAN_ORIGINS — the AI
// Gate's own kill switch is exactly the kind of trusted control an AI
// origin must never be able to flip for itself.
const NON_HUMAN_ORIGINS = new Set([
  "runner", "ai_planner", "recorder", "network_observer", "impacted_testing", "mcp_tool",
]);
function requireHumanApprover(approver) {
  if (!approver || typeof approver !== "string")
    throw new AiGateError("no_approver", "A human identity is required to change the AI Gate's kill switch.");
  if (NON_HUMAN_ORIGINS.has(approver))
    throw new AiGateError("non_human_approver", "Only a human operator can enable or disable AI.");
}

export function openAiGate(db, audit, { modelRouter }) {
  const safety = openAiSafety(db, audit);
  function isEnabled() {
    return Boolean(db.prepare("SELECT ai_enabled FROM ai_gate_settings WHERE id=1").get()?.ai_enabled);
  }

  function setEnabled(enabled, by) {
    requireHumanApprover(by);
    if (enabled && !safety.verifyLedger().intact)
      throw new AiGateError("ledger_integrity", "The AI decision ledger needs investigation before AI can be enabled.");
    if (enabled) safety.reset(by);
    db.prepare("UPDATE ai_gate_settings SET ai_enabled=?,updated_at=?,updated_by=? WHERE id=1")
      .run(enabled ? 1 : 0, now(), by);
    audit?.("ai_gate.toggled", "ai_gate_settings", { enabled, by });
    return { enabled };
  }

  function logRequest({ task, category, phase, reason, requester, input, errorCode = null }) {
    const id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO ai_gate_requests(id,task,category,allowed,reason,requester,provider,model,runbook_id,model_usage_id,error_code,created_at)
         VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)`,
      ).run(id, task, category, 0, reason, requester, errorCode ?? "in_flight", now());
      safety.append({ gateRequestId: id, phase, task, requester, input, errorCode });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit?.("ai_gate.request", id, { task, category, phase, requester });
    return id;
  }

  function completeRequest(id, { task, requester, input, result = null, errorCode = null }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE ai_gate_requests SET allowed=?,provider=?,model=?,error_code=? WHERE id=?")
        .run(result ? 1 : 0, result?.provider ?? null, result?.usage?.model ?? null, errorCode, id);
      safety.append({
        gateRequestId: id, phase: result ? "completed" : "failed", task, requester,
        provider: result?.provider ?? null, model: result?.usage?.model ?? null,
        input, output: result, errorCode,
      });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit?.("ai_gate.completed", id, { task, outcome: result ? "completed" : "failed", errorCode });
  }

  function validateResult(task, params, result) {
    if (task !== "planLogin") return;
    const scenarios = result?.plan?.scenarios;
    if (result?.plan?.title !== "Login essentials" || !Array.isArray(scenarios) || !scenarios.length ||
        new Set(scenarios).size !== scenarios.length || scenarios.some((s) => !ALLOWED_SCENARIOS.includes(s)) ||
        (!params?.negativeAllowed && scenarios.includes("invalid_password")))
      throw new AiGateError("invalid_model_output", "The AI response did not match the approved login plan. No plan has been saved.");
  }

  /** Attaches the runbook/model_usage rows a request produced, once they
   * exist — mirrors router.mjs's own recordModelUsage(), which is called
   * only after its runbook row exists (a runbook_id foreign key can't
   * reference a row that isn't there yet). Either field can be attached
   * independently and later, without overwriting the other. */
  function finalizeRequest(requestId, { runbookId = null, modelUsageId = null } = {}) {
    db.prepare("UPDATE ai_gate_requests SET runbook_id=COALESCE(?,runbook_id),model_usage_id=COALESCE(?,model_usage_id) WHERE id=?")
      .run(runbookId, modelUsageId, requestId);
  }

  /**
   * The only path any caller should use to reach a real AI provider.
   * Throws AiGateError — never silently falls through to a provider call
   * — when AI is disabled or the task has no registered category
   * (section 2.4: "no silent AI fallback"). Every call is logged,
   * allowed or refused, before this function returns or throws.
   */
  async function run(task, params, { requester, reason }) {
    if (!requester) throw new AiGateError("no_requester", "An AI Gate request requires a requester identity.");
    if (!reason) throw new AiGateError("no_reason", "An AI Gate request requires a reason.");
    if (!safety.verifyLedger().intact) {
      safety.trip("ledger_integrity", null, "critical");
      throw new AiGateError("ledger_integrity", "The AI decision ledger failed its integrity check. AI is paused for human review.");
    }
    const category = TASK_CATEGORIES[task];
    if (!category) {
      const id = logRequest({ task, category: "UNKNOWN", phase: "refused", reason, requester, input: params, errorCode: "unknown_task" });
      safety.trip("unknown_task", id);
      throw new AiGateError("unknown_task", `"${task}" has no registered AI Gate category — refusing rather than silently allowing it.`);
    }
    if (!isEnabled()) {
      logRequest({ task, category, phase: "refused", reason, requester, input: params, errorCode: "ai_disabled" });
      throw new AiGateError("ai_disabled", "AI is currently disabled. This request needs human review instead of a model call.");
    }
    if (safety.isCircuitOpen()) {
      logRequest({ task, category, phase: "refused", reason, requester, input: params, errorCode: "circuit_open" });
      throw new AiGateError("circuit_open", "AI is paused by the safety circuit. Review the incident before re-enabling AI.");
    }
    if (safety.hourlyCalls() >= AI_HOURLY_LIMIT) {
      const id = logRequest({ task, category, phase: "refused", reason, requester, input: params, errorCode: "request_budget" });
      safety.trip("request_budget", id, "medium");
      throw new AiGateError("request_budget", "The hourly AI request limit was reached. AI is paused for operator review.");
    }
    const aiGateRequestId = logRequest({ task, category, phase: "started", reason, requester, input: params });
    let result;
    try {
      result = await modelRouter.run(task, params);
      validateResult(task, params, result);
    } catch (error) {
      const errorCode = error instanceof AiGateError ? error.code :
        ["unsafe_input", "unsupported_request"].includes(error?.code) ? error.code : "provider_failure";
      completeRequest(aiGateRequestId, { task, requester, input: params, errorCode });
      if (safety.recentFailures() >= AI_FAILURE_LIMIT) safety.trip("repeated_ai_failure", aiGateRequestId);
      throw error;
    }
    completeRequest(aiGateRequestId, { task, requester, input: params, result });
    return { ...result, aiGateRequestId };
  }

  /** section 4's AI Usage panel — deterministic, DB-derived numbers only.
   * Deliberately never estimates a dollar cost: migration 008 already
   * established that this project has no real pricing table, and
   * fabricating one would be an invented number, not a tracked fact. */
  function usageSummary({ sinceIso } = {}) {
    const since = sinceIso ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const requests = db.prepare("SELECT * FROM ai_gate_requests WHERE created_at>=? ORDER BY created_at DESC").all(since);
    const allowed = requests.filter((r) => r.allowed);
    const blocked = requests.filter((r) => !r.allowed);
    const tokens = db.prepare(
      `SELECT COALESCE(SUM(model_usage.input_tokens),0) AS inputTokens, COALESCE(SUM(model_usage.output_tokens),0) AS outputTokens
       FROM model_usage JOIN ai_gate_requests ON ai_gate_requests.model_usage_id = model_usage.id
       WHERE ai_gate_requests.created_at>=?`,
    ).get(since);
    const byTask = {};
    for (const r of requests) byTask[r.task] = (byTask[r.task] || 0) + 1;
    const runVolume = db.prepare(
      `SELECT count(*) AS totalRuns,
              sum(CASE WHEN runbooks.source='openai' THEN 1 ELSE 0 END) AS aiRuns
       FROM runs JOIN runbooks ON runbooks.id = runs.runbook_id
       WHERE runs.started_at>=?`,
    ).get(since);
    return {
      since,
      aiEnabled: isEnabled(),
      totalRequests: requests.length,
      allowedRequests: allowed.length,
      blockedRequests: blocked.length,
      byTask,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalRuns: runVolume.totalRuns || 0,
      runsUsingAi: runVolume.aiRuns || 0,
      recent: requests.slice(0, 20),
      safety: safety.summary(),
    };
  }

  return { isEnabled, setEnabled, run, finalizeRequest, usageSummary };
}
