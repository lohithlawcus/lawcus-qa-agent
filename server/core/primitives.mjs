import { createHash } from "node:crypto";

// V5 section 12 / migration Step 3 — Approved Primitive Registry.
//
// A primitive is a reusable, semantic, engineering-reviewed execution
// capability. It may run only when resolvePrimitive() finds it in this
// static in-source registry AND its live implementation source still
// hashes to the `approvedHash` recorded at registration. approvedHash is a
// literal string, not computed from the function it checks — editing an
// implementation without deliberately recomputing and updating that literal
// makes the primitive fail closed (hash_mismatch) instead of silently
// running changed behavior. Nothing here resolves an implementation
// dynamically (e.g. from an AI-supplied module path); every primitive is a
// fixed function reference chosen by the engineer who wrote this file.

export class PrimitiveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- Login primitive implementations, extracted from runner.mjs ----------

async function authOpenLoginPage({ page, origin }) {
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
}

async function authEnsureLoginFields({ page }) {
  const email = page.getByRole("textbox", {
    name: "Email address",
    exact: true,
  });
  const password = page.getByLabel("Password", { exact: true });
  if ((await email.count()) !== 1 || (await password.count()) !== 1)
    throw new Error("The login fields could not be identified uniquely.");
  return { email, password };
}

async function authResolveSubmitControl({ page, aliases }) {
  const matches = [];
  for (const name of aliases) {
    const loc = page.getByRole("button", { name, exact: true });
    if ((await loc.count()) > 1)
      throw new Error("The sign-in action is ambiguous.");
    if (
      (await loc.count()) === 1 &&
      (await loc.isVisible()) &&
      (await loc.isEnabled())
    )
      matches.push(name);
  }
  if (matches.length !== 1)
    throw new Error("The sign-in action could not be identified uniquely.");
  const candidate = matches[0];
  return {
    candidate,
    locator: page.getByRole("button", { name: candidate, exact: true }),
  };
}

async function authAssertPasswordMasked({ password }) {
  if ((await password.getAttribute("type")) !== "password")
    throw new Error("The password field is no longer concealed.");
}

async function authAssertEmptyFieldsBlocked({ page, email, password }) {
  const required =
    (await email.getAttribute("required")) !== null &&
    (await password.getAttribute("required")) !== null;
  const invalid = await email.evaluate((e) => !e.checkValidity());
  if (!required || !invalid || new URL(page.url()).pathname !== "/login")
    throw new Error(
      "Empty credentials were not stopped by the required-field checks.",
    );
}

async function authFillCredentials({ email, password, credentials }) {
  await email.fill(credentials.email);
  await password.fill(credentials.password);
}

async function authAssertInvalidCredentialsRejected({ page }) {
  await page
    .getByRole("alert")
    .filter({ hasText: "Invalid email or password" })
    .waitFor();
}

async function authAssertAuthenticatedWorkspace({ page }) {
  await page
    .getByRole("heading", { name: "Welcome, QA user", exact: true })
    .waitFor();
}

async function authLogout({ page }) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "Sign in to your workspace", exact: true })
    .waitFor();
}

async function authAssertProtectedRouteBlocked({ page, origin }) {
  await page.goto(`${origin}/workspace`);
  if (new URL(page.url()).pathname !== "/login")
    throw new Error(
      "The protected workspace was reachable without an authenticated session.",
    );
}

// --- Registry ---------------------------------------------------------

const registry = new Map();

function register(entry) {
  registry.set(entry.id, entry);
}

// Hashes below are computed from the exact function source above, at the
// time this file was authored, and pinned as literals — see
// server/tests/primitives.test.mjs, which fails closed if source and
// literal ever diverge.
register({
  id: "auth.open_login_page",
  version: 1,
  layer: "ui",
  action: "Navigate to the login page.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: ["navigation"],
  networkAuthority: ["environment-origin"],
  impl: authOpenLoginPage,
  approvedHash:
    "e8d91aad984d789caaef57473e16dcf0d838eec20bf9c242f16f579f75245206",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.ensure_login_fields",
  version: 1,
  layer: "ui",
  action: "Locate the email and password fields and require both to be unique.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: [],
  networkAuthority: [],
  impl: authEnsureLoginFields,
  approvedHash:
    "415aa6112e7de9db90a2d03834511f3fb1f94dfb903b5ca13c8bc9a33afb8910",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.resolve_submit_control",
  version: 1,
  layer: "ui",
  action:
    "Resolve the sign-in control among known semantic aliases, requiring exactly one unambiguous visible and enabled match.",
  status: "approved",
  risk: "medium",
  dependencies: [],
  sideEffects: [],
  networkAuthority: [],
  impl: authResolveSubmitControl,
  approvedHash:
    "78719943ffdb1b41e9eb3ea5918598e53bd042287e5d0d737661f53d29a3c970",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.assert_password_masked",
  version: 1,
  layer: "ui",
  action: "Assert the password field conceals typed characters.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: [],
  networkAuthority: [],
  impl: authAssertPasswordMasked,
  approvedHash:
    "a8fbba0e14c72cda642d130ba7d77aaf6d9012fdb796c469361e1d4f67305e4d",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.assert_empty_fields_blocked",
  version: 1,
  layer: "ui",
  action:
    "Assert that submitting empty credentials is blocked by required-field validation and no navigation occurred.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: [],
  networkAuthority: [],
  impl: authAssertEmptyFieldsBlocked,
  approvedHash:
    "069a8b6eca108bd8d8b305eb558ecd0bb875ccbd74565a4145c9be545cf013d5",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.fill_credentials",
  version: 1,
  layer: "ui",
  action: "Fill the email and password fields with the given credentials.",
  status: "approved",
  risk: "medium",
  dependencies: [],
  sideEffects: ["form-input"],
  networkAuthority: [],
  impl: authFillCredentials,
  approvedHash:
    "076abac1b81888a4bbd704e81f2ef31444071e043a0627020e7a86fd8763019f",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.assert_invalid_credentials_rejected",
  version: 1,
  layer: "ui",
  action: "Assert an explicit invalid-credentials alert is shown.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: [],
  networkAuthority: [],
  impl: authAssertInvalidCredentialsRejected,
  approvedHash:
    "2a1e27bfed672564702eacecc0ef28ef63e1f8daf968ab3a115929c9b60758f5",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.assert_authenticated_workspace",
  version: 1,
  layer: "ui",
  action: "Assert the authenticated workspace welcomes the QA user.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: [],
  networkAuthority: [],
  impl: authAssertAuthenticatedWorkspace,
  approvedHash:
    "a51dd0d90b27029b206eb987e8d03f694894a0c477c37215f1156fe3dd2aa429",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.logout",
  version: 1,
  layer: "ui",
  action: "Sign out and wait for the login page to return.",
  status: "approved",
  risk: "medium",
  dependencies: [],
  sideEffects: ["session-termination"],
  networkAuthority: [],
  impl: authLogout,
  approvedHash:
    "27c935ba4d6370955ecd3dd0fd941853fbfb05319b7cf1b6cfb5178ff13bd8f1",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});
register({
  id: "auth.assert_protected_route_blocked",
  version: 1,
  layer: "ui",
  action:
    "Navigate to the protected workspace route and assert it is not reachable without an authenticated session.",
  status: "approved",
  risk: "low",
  dependencies: [],
  sideEffects: ["navigation"],
  networkAuthority: ["environment-origin"],
  impl: authAssertProtectedRouteBlocked,
  approvedHash:
    "5045fc6b2621dbbe71cd06b532ab5a8c1271fbaa06ace283cc397be7854ac523",
  approvedBy: "operator:lohithreddysripathi",
  approvedAt: "2026-09-15T00:00:00.000Z",
});

export function computeImplementationHash(id) {
  const entry = registry.get(id);
  if (!entry)
    throw new PrimitiveError("unknown_primitive", `No such primitive: ${id}`);
  return sha256(entry.impl.toString());
}

// Pure and exported so the approval gate itself is directly testable
// without mutating the real static registry.
export function evaluatePrimitiveTrust(entry, liveHash) {
  if (!entry) return { trusted: false, reason: "unknown_primitive" };
  if (entry.status !== "approved")
    return {
      trusted: false,
      reason:
        entry.status === "deprecated" ? "deprecated_primitive" : "not_approved",
    };
  if (liveHash !== entry.approvedHash)
    return { trusted: false, reason: "hash_mismatch" };
  return { trusted: true };
}

const FAILURE_MESSAGES = {
  unknown_primitive: (id) => `No such approved primitive: ${id}`,
  deprecated_primitive: (id) =>
    `Primitive ${id} is deprecated and cannot execute.`,
  not_approved: (id) => `Primitive ${id} is not approved for execution.`,
  hash_mismatch: (id) =>
    `Primitive ${id}'s implementation changed since approval and is not trusted to execute. Re-review and update its approved hash.`,
};

export function resolvePrimitive(id) {
  const entry = registry.get(id);
  const liveHash = entry ? sha256(entry.impl.toString()) : null;
  const trust = evaluatePrimitiveTrust(entry, liveHash);
  if (!trust.trusted)
    throw new PrimitiveError(trust.reason, FAILURE_MESSAGES[trust.reason](id));
  return {
    id: entry.id,
    version: entry.version,
    layer: entry.layer,
    action: entry.action,
    risk: entry.risk,
    run: (ctx) => entry.impl(ctx),
  };
}

export function listPrimitives() {
  return [...registry.values()].map((entry) => ({
    id: entry.id,
    version: entry.version,
    layer: entry.layer,
    action: entry.action,
    status: entry.status,
    risk: entry.risk,
    dependencies: entry.dependencies,
    sideEffects: entry.sideEffects,
    networkAuthority: entry.networkAuthority,
    approvedBy: entry.approvedBy,
    approvedAt: entry.approvedAt,
  }));
}
