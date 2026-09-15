import { randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";

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
  function isEnabled() {
    return Boolean(db.prepare("SELECT ai_enabled FROM ai_gate_settings WHERE id=1").get()?.ai_enabled);
  }

  function setEnabled(enabled, by) {
    requireHumanApprover(by);
    db.prepare("UPDATE ai_gate_settings SET ai_enabled=?,updated_at=?,updated_by=? WHERE id=1")
      .run(enabled ? 1 : 0, now(), by);
    audit?.("ai_gate.toggled", "ai_gate_settings", { enabled, by });
    return { enabled };
  }

  function logRequest({ task, category, allowed, reason, requester, provider = null, model = null, errorCode = null }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO ai_gate_requests(id,task,category,allowed,reason,requester,provider,model,runbook_id,model_usage_id,error_code,created_at)
       VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,?)`,
    ).run(id, task, category, allowed ? 1 : 0, reason, requester, provider, model, errorCode, now());
    audit?.("ai_gate.request", id, { task, category, allowed, requester });
    return id;
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
    const category = TASK_CATEGORIES[task];
    if (!category) {
      logRequest({ task, category: "UNKNOWN", allowed: false, reason, requester, errorCode: "unknown_task" });
      throw new AiGateError("unknown_task", `"${task}" has no registered AI Gate category — refusing rather than silently allowing it.`);
    }
    if (!isEnabled()) {
      logRequest({ task, category, allowed: false, reason, requester, errorCode: "ai_disabled" });
      throw new AiGateError("ai_disabled", "AI is currently disabled. This request needs human review instead of a model call.");
    }
    const result = await modelRouter.run(task, params);
    const aiGateRequestId = logRequest({ task, category, allowed: true, reason, requester, provider: result.provider, model: result.usage?.model ?? null });
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
    };
  }

  return { isEnabled, setEnabled, run, finalizeRequest, usageSummary };
}
