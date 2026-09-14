import { randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";

// V5 Step 8 / section 33 — the ModelRouter + TaskPolicy. This is the only
// place in the codebase that decides which provider and which model
// handles a named task; every caller asks for a task by name and never
// mentions a provider or model directly, so swapping either later is a
// one-line policy change here, not a change to every call site.
//
// AIProvider contract: an object with an `id` and one async method per
// task it supports, named identically to the task key (a valid JS
// identifier, e.g. `planLogin`), called as `provider[task](params, { model })`,
// resolving to { plan, summary, source, modelCalls, usage } (usage is
// optional — omit it for a task that doesn't report tokens).
//
// Only one task exists right now (this app has exactly one AI-consuming
// job: turning operator intent into a login plan), so there's only one
// policy entry. Section 33's tiered routing table (deterministic -> no
// model, simple extraction -> cheap model, hard reasoning -> stronger
// model) applies once more task types actually exist — adding placeholder
// tiers for tasks that don't exist yet would be routing "for appearance,"
// which the spec explicitly says not to do.
export const TASK_POLICY = {
  planLogin: { provider: "openai", model: "gpt-4.1-mini" },
};

export class ModelRoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Deliberately stateless (no `db`): the router only decides provider/model
// and dispatches. Persisting usage is the caller's job, and must happen
// once whatever the usage is attributed to actually exists — for
// login-plan that's a runbook row, which callers create after planning
// succeeds; recording usage here, before that row exists, would violate
// model_usage.runbook_id's foreign key. See recordModelUsage() below.
//
// `policy` defaults to TASK_POLICY and exists as a parameter (not just a
// module import) so a provider swap can be demonstrated and tested without
// editing this file — the concrete proof that routing is a policy, not
// something baked into call sites.
export function createModelRouter({ providers, policy = TASK_POLICY }) {
  return {
    async run(task, params) {
      const taskPolicy = policy[task];
      if (!taskPolicy)
        throw new ModelRoutingError(
          "unknown_task",
          `No routing policy for task "${task}".`,
        );
      const provider = providers[taskPolicy.provider];
      if (!provider)
        throw new ModelRoutingError(
          "provider_not_registered",
          `Provider "${taskPolicy.provider}" is not registered.`,
        );
      const method = provider[task];
      if (typeof method !== "function")
        throw new ModelRoutingError(
          "task_not_supported",
          `Provider "${taskPolicy.provider}" does not implement task "${task}".`,
        );
      const result = await method(params, { model: taskPolicy.model });
      return { ...result, provider: taskPolicy.provider, task };
    },
  };
}

// Cost controls / section 33.3: track provider, model, purpose and tokens
// for every call that actually reached a model. Never called for a result
// with no `usage` (the standard/intent-router/fixture paths never call a
// model at all, and a rejected call reports no usage today either).
export function recordModelUsage(db, { result, runbookId }) {
  if (!result?.usage) return;
  db.prepare(
    `INSERT INTO model_usage(id,provider,model,purpose,input_tokens,output_tokens,runbook_id,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    result.provider,
    result.usage.model,
    result.task,
    result.usage.inputTokens || 0,
    result.usage.outputTokens || 0,
    runbookId,
    now(),
  );
}
