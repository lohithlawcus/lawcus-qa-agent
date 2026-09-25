import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  REDACTED, registerSecret, noteKeychainValue, clearRegisteredSecrets, redactText, redactValue,
  safeErrorMessage, sanitizeErrorBody, containsSecret,
} from "../core/redact.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

// Every "secret" in this file is a made-up value.
const PASSWORD = "Tr0ub4dor&3-fake";
const TOKEN = "abcDEF1234567890xyzFAKE";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlZmFrZQ";

test.beforeEach(() => clearRegisteredSecrets());
test.afterEach(() => clearRegisteredSecrets());

// ---------- exact-match layer ----------

test("a registered secret is masked wherever it appears, including its URL-encoded, JSON-escaped and base64 forms", () => {
  registerSecret(PASSWORD);
  const forms = [
    PASSWORD,
    encodeURIComponent(PASSWORD),
    JSON.stringify(PASSWORD).slice(1, -1),
    Buffer.from(PASSWORD).toString("base64"),
  ];
  for (const form of forms) {
    const out = redactText(`something went wrong near ${form} in the form`);
    assert.ok(!out.includes(form), `form not masked: ${form}`);
    assert.ok(out.includes(REDACTED));
  }
  assert.equal(redactText(`a ${PASSWORD} b ${PASSWORD} c`), `a ${REDACTED} b ${REDACTED} c`);
});

test("a secret with NO label around it (the case patterns cannot catch) is masked once registered", () => {
  // Documented limit: with no label and no registration, nothing can know this is a secret.
  assert.ok(redactText(`fill failed for ${PASSWORD}`).includes(PASSWORD));
  registerSecret(PASSWORD);
  assert.equal(redactText(`the value was ${PASSWORD}.`), `the value was ${REDACTED}.`);
});

test("values shorter than 6 characters are never registered (they would mask ordinary words)", () => {
  registerSecret("abc");
  registerSecret("");
  registerSecret(null);
  registerSecret(12345678);
  assert.equal(redactText("abc def"), "abc def");
});

test("noteKeychainValue registers a JSON credential's password but not its username", () => {
  noteKeychainValue(JSON.stringify({ username: "qa.user@example.test", password: PASSWORD }));
  assert.ok(!redactText(`x ${PASSWORD} y`).includes(PASSWORD));
  assert.ok(redactText("logged in as qa.user@example.test").includes("qa.user@example.test"), "an identifier is not a secret");
});

test("noteKeychainValue registers an opaque secret as-is and ignores empty or malformed input", () => {
  noteKeychainValue("opaque-api-key-value-123");
  assert.ok(!redactText("k=opaque-api-key-value-123").includes("opaque-api-key-value-123"));
  for (const v of [undefined, null, "", 42, "{not json"]) assert.doesNotThrow(() => noteKeychainValue(v));
});

// ---------- pattern layer ----------

test("credential-shaped text is masked even when the value was never registered", () => {
  const cases = [
    [`Authorization: Bearer ${TOKEN}`, TOKEN],
    [`sent Bearer ${TOKEN} to the api`, TOKEN],
    [`token: ${JWT}`, JWT],
    [`saw ${JWT} in the response`, JWT],
    ["key sk-abcdefghijklmnop1234567890 leaked", "sk-abcdefghijklmnop1234567890"],
    ["Cookie: sid=abc123def456; theme=dark; other=1", "abc123def456"],
    ["Set-Cookie: session=zzzTOPSECRETzzz; HttpOnly", "zzzTOPSECRETzzz"],
    [`password=${PASSWORD}`, PASSWORD],
    [`password: ${PASSWORD}`, PASSWORD],
    [`{"password":"${PASSWORD}","email":"a@b.test"}`, PASSWORD],
    [`{'access_token': '${TOKEN}'}`, TOKEN],
    [`https://x.test/cb?access_token=${TOKEN}&x=1`, TOKEN],
    [`https://x.test/login?password=${PASSWORD}`, PASSWORD],
    [`api_key=${TOKEN}`, TOKEN],
    [`x-api-key: ${TOKEN}`, TOKEN],
  ];
  for (const [text, secret] of cases) {
    const out = redactText(text);
    assert.ok(!out.includes(secret), `leaked in: ${text} -> ${out}`);
    assert.ok(out.includes(REDACTED), `nothing masked in: ${text}`);
  }
});

test("an unregistered password containing punctuation is masked in full, not cut at the first & , ; } ] or )", () => {
  for (const pw of ["Tr0ub4dor&3-fake", "a,b;c}d]e)f", "p@ss&Zebra&Quokka&stuff", "x=y=z", "semi;colon;end"]) {
    for (const text of [`password=${pw}`, `password: ${pw}`, `login failed for password=${pw} at step 2`]) {
      const out = redactText(text);
      for (const piece of pw.split(/[&,;}\])=]/).filter((x) => x.length >= 3)) assert.ok(!out.includes(piece), `fragment "${piece}" leaked from "${text}" -> "${out}"`);
    }
  }
});

test("a Playwright call log's typed argument is masked, whatever the value is", () => {
  const log = `elementHandle.fill: Element is not editable\nCall log:\n  - fill("${PASSWORD}")\n  - attempting fill action\n    - element is not editable`;
  const out = redactText(log);
  assert.ok(!out.includes(PASSWORD));
  assert.match(out, /fill\("\[REDACTED\]"\)/);
  assert.match(out, /attempting fill action/, "the rest of the log survives");
  for (const call of [`type('${PASSWORD}')`, `press("${PASSWORD}")`, `pressSequentially("${PASSWORD}")`, `fill("a \\" quote ${PASSWORD}")`]) {
    assert.ok(!redactText(`x ${call} y`).includes(PASSWORD), call);
  }
});

test("ordinary error text, selectors and identifiers are NOT mangled", () => {
  const benign = [
    "Password is required",
    "Email is required",
    "Keep the password concealed",
    "getByPlaceholder('Search your practice', { exact: true }) to be visible",
    `waiting for locator('input[type="password"]')`,
    "locator.waitFor: Timeout 35000ms exceeded.",
    "net::ERR_BLOCKED_BY_CLIENT.Inspector",
    "Basic Details",
    "Basic information about the contact",
    "password_masked",
    "contacts.create_all_fields_verified_on_detail_page",
    `https://lohith.fiveriverz.com/contact/${randomUUID()}`,
    randomUUID(),
    "Custom Text",
    "QA impacted-test 1790000000001",
    "Could not determine the created contact's uuid from the post-save URL: https://x/contacts",
    "session expired, please sign in again",
    "The staging login password input masks typed characters.",
  ];
  for (const text of benign) assert.equal(redactText(text), text, `mangled: ${text}`);
});

test("redactText is idempotent, passes non-strings through, and truncates on request", () => {
  const text = `password=${PASSWORD} Bearer ${TOKEN}`;
  assert.equal(redactText(redactText(text)), redactText(text));
  for (const v of [null, undefined, 5, {}, ""]) assert.equal(redactText(v), v);
  const long = "x".repeat(1000);
  assert.equal(redactText(long, { maxLength: 100 }).length, 101);
});

test("containsSecret is true exactly when masking would change the text", () => {
  registerSecret(PASSWORD);
  assert.equal(containsSecret(`please use ${PASSWORD}`), true);
  assert.equal(containsSecret(`password: hunter2`), true);
  assert.equal(containsSecret("Test the login page."), false);
  assert.equal(containsSecret("Update a contact custom field and check how it appears for existing/new Contact and Lead."), false);
  assert.equal(containsSecret(undefined), false);
});

// ---------- structured values ----------

test("redactValue masks secret-named keys (any casing style) and secrets inside strings, deeply", () => {
  registerSecret(PASSWORD);
  const out = redactValue({
    password: PASSWORD,
    accessToken: TOKEN,
    "x-api-key": TOKEN,
    Authorization: `Bearer ${TOKEN}`,
    nested: { list: [{ client_secret: "s3cr3t-value-here" }, `note ${PASSWORD}`], ok: "fine" },
    cookie: "a=b",
    email: "qa@example.test",
    password_masked: true,
    token: null,
    count: 3,
  });
  const flat = JSON.stringify(out);
  for (const leaked of [PASSWORD, TOKEN, "s3cr3t-value-here", "a=b"]) assert.ok(!flat.includes(leaked), `leaked ${leaked}: ${flat}`);
  assert.equal(out.email, "qa@example.test");
  assert.equal(out.nested.ok, "fine");
  assert.equal(out.password_masked, true, "a boolean flag about a password is not a secret");
  assert.equal(out.token, null);
  assert.equal(out.count, 3);
});

test("redactValue handles buffers, errors, circular references and depth without throwing or leaking", () => {
  registerSecret(PASSWORD);
  const circular = { a: 1 };
  circular.self = circular;
  assert.equal(redactValue(circular).self, "[circular]");
  assert.equal(redactValue(Buffer.from("PNG-BYTES")), "[binary 9 bytes]");
  const err = redactValue(new Error(`bad ${PASSWORD}`));
  assert.deepEqual(Object.keys(err).sort(), ["message", "name"]);
  assert.ok(!JSON.stringify(err).includes(PASSWORD));
  let deep = { v: PASSWORD };
  for (let i = 0; i < 20; i++) deep = { deeper: deep };
  assert.ok(!JSON.stringify(redactValue(deep)).includes(PASSWORD));
});

test("safeErrorMessage masks, truncates and tolerates non-errors", () => {
  registerSecret(PASSWORD);
  assert.equal(safeErrorMessage(new Error(`x ${PASSWORD}`)), `x ${REDACTED}`);
  assert.equal(safeErrorMessage("plain string"), "plain string");
  assert.equal(safeErrorMessage(undefined), "Unknown error");
  assert.ok(safeErrorMessage(new Error("y".repeat(2000))).length <= 501);
});

test("sanitizeErrorBody masks the human-readable fields only and never throws on odd input", () => {
  registerSecret(PASSWORD);
  const out = sanitizeErrorBody({ error: `boom ${PASSWORD}`, errors: [`a ${PASSWORD}`, { message: `b ${PASSWORD}` }], id: "keep-me" });
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.equal(out.id, "keep-me");
  for (const v of [null, undefined, "str", 5]) assert.equal(sanitizeErrorBody(v), v);
});
