import { z } from "zod";
export const Scenario = z.enum([
  "valid_login",
  "invalid_password",
  "empty_fields",
  "password_masked",
  "logout",
]);
export const Plan = z
  .object({
    title: z.literal("Login essentials"),
    scenarios: z.array(Scenario).min(1).max(5),
  })
  .strict()
  .superRefine((p, c) => {
    if (new Set(p.scenarios).size !== p.scenarios.length)
      c.addIssue({
        code: "custom",
        message: "Duplicate scenarios are not permitted.",
      });
  });
export const PlanRequest = z
  .object({
    intent: z.string().trim().min(3).max(1000),
    // V5 "add two more urls" (2026-09-17) — Co Server / Prod USA / Prod EU
    // joined "fixture"/"lawcus" as real, live-verified Login-suite targets.
    environmentId: z.enum(["fixture", "lawcus", "co-server", "prod-usa", "prod-eu"]),
    planner: z.enum(["ai", "standard"]).default("ai"),
  })
  .strict();
export const RunRequest = z
  .object({ runbookId: z.string().uuid(), idempotencyKey: z.string().uuid() })
  .strict();
export const AnswerRequest = z
  .object({ answer: z.string().trim().min(3).max(1000) })
  .strict();
export const DecisionRequest = z
  .object({ note: z.string().trim().min(1).max(1000).optional() })
  .strict();
export const ImpactedTestRequest = z
  .object({ intent: z.string().trim().min(3).max(1000) })
  .strict();
export const KnowledgeImportRequest = z
  .object({ text: z.string().min(1).max(200000) })
  .strict();
export const AiGateToggleRequest = z.object({ enabled: z.boolean() }).strict();
// A person deals with a record a run left in staging: they removed it in
// Lawcus themselves ("removed"), or decided to keep it ("keep").
export const LeftoverResolveRequest = z
  .object({ action: z.enum(["removed", "keep"]), note: z.string().max(300).optional() })
  .strict();
export const descriptions = {
  valid_login: {
    title: "Sign in with the dedicated test account",
    expected: "The authenticated workspace welcomes the fixture QA user.",
  },
  invalid_password: {
    title: "Reject an incorrect password",
    expected:
      "An explicit invalid-credentials message appears and the workspace stays inaccessible.",
  },
  empty_fields: {
    title: "Keep empty credentials out",
    expected: "Required email and password fields prevent an empty submission.",
  },
  password_masked: {
    title: "Keep the password concealed",
    expected: "The password input masks typed characters.",
  },
  logout: {
    title: "Sign out and invalidate the session",
    expected:
      "The login page returns and the protected workspace rejects the old session.",
  },
};
export function builtInPlan(intent) {
  if (
    !/^(test|check|regression test|thoroughly test|retest)\s+(the\s+)?(login(\s+page)?|sign[ -]?in)(\s+(thoroughly|again))?[.!]?$/i.test(
      intent.trim(),
    )
  )
    throw new Error(
      "This first version understands login testing. Try “Test the login page.” Other features and plan amendments need a connected planner and verified product knowledge.",
    );
  return Plan.parse({
    title: "Login essentials",
    scenarios: Object.keys(descriptions),
  });
}
export async function createPlan(intent) {
  // Local provider only: never export operator text to an external model by default.
  const endpoint = process.env.QA_PLANNER_URL;
  if (!endpoint)
    return { plan: builtInPlan(intent), source: "built-in", modelCalls: 0 };
  const u = new URL(endpoint);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.username ||
    u.password
  )
    throw new Error("The optional planner must be a loopback service.");
  const response = await fetch(u, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent,
      allowedScenarios: Object.keys(descriptions),
      title: "Login essentials",
      instruction:
        "Return only a JSON plan. Never invent application rules. This contract is for the synthetic login fixture.",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      "The planning service is unavailable. No test was created.",
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The planner returned an empty response.");
  let body = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 10000)
        throw new Error("The planner returned too much content.");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return {
    plan: Plan.parse(JSON.parse(body)),
    source: "local-model",
    modelCalls: 1,
  };
}
export function validateExecution(environment) {
  if (
    !environment ||
    environment.id !== "fixture" ||
    environment.kind !== "fixture" ||
    !environment.execution_enabled
  )
    throw new Error(
      "Live Lawcus execution is blocked pending secure credential integration and worker network isolation.",
    );
}
export function isAllowedRequest(url, method, origin) {
  try {
    const u = new URL(url);
    return (
      u.origin === origin &&
      !u.username &&
      !u.password &&
      (["GET", "HEAD"].includes(method) ||
        (method === "POST" && ["/login", "/logout"].includes(u.pathname)))
    );
  } catch {
    return false;
  }
}
// V5 Step 1: this function no longer authorizes a repair. It only decides
// whether a candidate is worth PROPOSING to a human. Nothing in the runtime may
// promote a locator on the strength of this result alone.
export function evaluateLocatorCandidate({
  current,
  candidate,
  sameAssertion,
  uniqueCandidate,
  knownAlias,
  postconditionPassed,
}) {
  const signals = {
    sameAssertion: Boolean(sameAssertion),
    uniqueCandidate: Boolean(uniqueCandidate),
    knownAlias: Boolean(knownAlias),
    postconditionPassed: Boolean(postconditionPassed),
  };
  const met = Object.values(signals).filter(Boolean).length;
  return {
    proposalWarranted:
      candidate !== current && Object.values(signals).every(Boolean),
    confidence: met / 4,
    signals,
    // Explicit: approval is a human transition, never a runtime one.
    autoApplyPermitted: false,
  };
}
