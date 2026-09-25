// One place that decides what may leave this process as text. Every
// boundary that stores or returns text derived from a browser, a request or
// an error (audit events, stored error messages, HTTP and MCP responses,
// captured console output, model prompts) goes through here.
//
// Two layers, because neither is enough alone:
//  1. Exact-match masking of secrets this process has actually read or
//     saved (the QA password, an API key, the evidence key) — registered by
//     secrets.mjs. This is the only layer that can catch a secret with no
//     label around it. It matters in practice: Playwright's own error text
//     includes the typed value when a fill() fails on a read-only or
//     disabled field, and puts URL query strings into goto() errors.
//  2. Pattern masking of things that look like credentials whatever their
//     value (bearer tokens, JWTs, API keys, password=..., cookie lines, and
//     the quoted argument of fill()/type()/press() in a call log).
//
// This is defense in depth on top of code that already avoids logging
// values (bodies are summarized as keys only, login traces carry no
// values) — it is not a license to log raw request bodies.

export const REDACTED = "[REDACTED]";

const MIN_SECRET_LENGTH = 6; // shorter values would mask ordinary words
const MAX_REGISTERED = 200;
const registered = new Set();

function variantsOf(value) {
  const v = String(value);
  const out = new Set([v, JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64")]);
  try {
    out.add(encodeURIComponent(v));
  } catch {
    // an unpaired surrogate cannot be URI-encoded; the other forms still apply
  }
  return [...out].filter((x) => x.length >= MIN_SECRET_LENGTH);
}

/** Remember a secret value (and its URL-encoded, JSON-escaped and base64
 * forms) so it is masked wherever it appears in text from now on. */
export function registerSecret(value) {
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
  if (registered.size >= MAX_REGISTERED) return;
  for (const variant of variantsOf(value)) registered.add(variant);
}

// Names whose value is a secret when the stored credential is a JSON object
// (e.g. the login credential {username, password}). The username is not
// registered: it is an identifier, and masking it would only hurt diagnosis.
const SECRET_FIELD = /pass|secret|token|key/i;

/** Called by secrets.mjs with whatever the Keychain returned or was given. */
export function noteKeychainValue(rawValue) {
  if (typeof rawValue !== "string" || !rawValue) return;
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) if (SECRET_FIELD.test(key)) registerSecret(value);
  } else {
    registerSecret(rawValue); // an opaque secret (API key, evidence key)
  }
}

/** Tests only. */
export function clearRegisteredSecrets() {
  registered.clear();
}

const KEY_NAMES =
  "password|passwd|pwd|passphrase|secret|client_secret|access_token|refresh_token|id_token|token|api[_-]?key|apikey|x-api-key|authorization|session[_-]?id|sessionid|sid|csrf|xsrf";

const PATTERNS = [
  // Bearer tokens
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  // OpenAI-style API keys (same shape secrets.mjs/openai.mjs already guard)
  [/\bsk-[A-Za-z0-9_-]{15,}/g, REDACTED],
  // Cookie / Set-Cookie header lines: the whole remainder is credential
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, `$1${REDACTED}`],
  // key: value / key=value / "key":"value" for credential-looking keys. An
  // unquoted value runs to the next whitespace, not to the next punctuation:
  // passwords routinely contain & , ; } ] and stopping there would leak the tail.
  [
    new RegExp(`(["']?\\b(?:${KEY_NAMES})\\b["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s"']+)`, "gi"),
    (_match, prefix, value) => `${prefix}${value.startsWith('"') ? `"${REDACTED}"` : value.startsWith("'") ? `'${REDACTED}'` : REDACTED}`,
  ],
  // credential-looking URL query parameters
  [/([?&](?:password|passwd|pwd|token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|secret|sig|signature|auth|code|session[_-]?id|sid)=)[^&#\s"'<>)]+/gi, `$1${REDACTED}`],
  // the quoted argument in a Playwright call log: fill("…"), type('…'), press("…")
  [/\b(fill|type|pressSequentially|insertText|press)\((["'`])(?:\\.|(?!\2)[^\\])*\2/g, `$1($2${REDACTED}$2`],
];

export function redactText(input, { maxLength = null } = {}) {
  if (typeof input !== "string" || input === "") return input;
  let text = input;
  const exact = [...registered].sort((a, b) => b.length - a.length);
  for (const secret of exact) if (text.includes(secret)) text = text.split(secret).join(REDACTED);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return maxLength && text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** True if masking would change this text — i.e. it contains something that
 * is, or looks like, a credential. */
export function containsSecret(text) {
  return typeof text === "string" && redactText(text) !== text;
}

// A key that names a secret hides its value whatever the value looks like.
// Booleans/null are left alone so flags like {password_masked: true} survive.
const SENSITIVE_KEY = /(^|_)(pass(word|wd|phrase)?|pwd|secret|token|authorization|cookie|api_?key|apikey|credentials?|bearer)(_|$)/;
const isSensitiveKey = (key) => SENSITIVE_KEY.test(String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase());

export function redactValue(value, { maskKeys = true } = {}) {
  return walk(value, 8, new WeakSet(), maskKeys);
}

function walk(value, depth, seen, maskKeys) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (depth <= 0) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: safeErrorMessage(value) };
  if (Array.isArray(value)) return value.map((item) => walk(item, depth - 1, seen, maskKeys));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = maskKeys && isSensitiveKey(key) && item !== null && typeof item !== "boolean" && item !== undefined ? REDACTED : walk(item, depth - 1, seen, maskKeys);
  }
  return out;
}

/** An error's message, safe to store or return. */
export function safeErrorMessage(error, maxLength = 500) {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return redactText(String(raw), { maxLength });
}

/** For HTTP error bodies: masks the human-readable text fields. */
export function sanitizeErrorBody(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  if (typeof out.error === "string") out.error = redactText(out.error);
  if (typeof out.message === "string") out.message = redactText(out.message);
  if (Array.isArray(out.errors)) out.errors = out.errors.map((e) => (typeof e === "string" ? redactText(e) : redactValue(e)));
  return out;
}
