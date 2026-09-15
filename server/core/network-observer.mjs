import { validateShape, validateResponseAgainstContract } from "./schema-shape.mjs";
import { summarizeBody } from "./sanitize.mjs";

// V5 Step 11 / section 23 — Browser Network Contract Observer.
//
// attachNetworkObserver() only ever records what a real browser context
// actually sent and actually received — never what the runner *thinks* it
// asked for. A request our own security policy blocks (route.abort()) never
// fires 'response', so it is correctly absent from events: it never reached
// the real API, and must not be counted as "the expected call happened."
//
// correlateObservation() is pure and DB-free (easy to unit-test in
// isolation) — it matches captured events against one resolved contract by
// host+method+path, checks the declared cardinality, and validates each
// match's shape via schema-shape.mjs. Section 23: "Do not use — I saw a
// similar PUT somewhere during the test" — correlation here is exact
// host+method+path matching against the contract's own path template, not
// a fuzzy guess.

const MAX_EVENTS = 200;
const MAX_CONSOLE_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 500;

export function pathMatchesTemplate(pathname, template) {
  const pattern = "^" + template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-zA-Z0-9_]+/g, "[^/]+") + "$";
  return new RegExp(pattern).test(pathname);
}

/** Installs listeners on a Playwright BrowserContext and accumulates
 * sanitized-at-source events (request/response bodies kept in memory only
 * long enough for correlateObservation() to check their shape — nothing
 * here writes a raw value to disk or the database; see network-observations.mjs
 * for what actually gets persisted). Bounded so a chatty page can't grow
 * these arrays without limit. */
export function attachNetworkObserver(context) {
  const events = [];
  const consoleEntries = [];

  // Pushed synchronously on the 'response' event itself, so cardinality
  // counting can never race a correlation check that runs moments later —
  // only the body of a JSON response is filled in asynchronously afterward
  // (postDataJSON() is synchronous; reading a response body is not).
  const onResponse = (response) => {
    if (events.length >= MAX_EVENTS) return;
    const request = response.request();
    let requestBody = null;
    try {
      requestBody = request.postDataJSON();
    } catch {
      requestBody = null;
    }
    const entry = {
      method: request.method(),
      url: request.url(),
      status: response.status(),
      requestBody,
      responseBody: null,
      observedAt: Date.now(),
    };
    events.push(entry);
    const contentType = response.headers()["content-type"] || "";
    if (contentType.includes("json"))
      response
        .json()
        .then((body) => {
          entry.responseBody = body;
        })
        .catch(() => {});
  };
  const onConsole = (message) => {
    if (message.type() !== "error" || consoleEntries.length >= MAX_CONSOLE_ENTRIES) return;
    consoleEntries.push({
      level: "console-error",
      message: String(message.text()).slice(0, MAX_MESSAGE_LENGTH),
      observedAt: Date.now(),
    });
  };
  const onWebError = (webError) => {
    if (consoleEntries.length >= MAX_CONSOLE_ENTRIES) return;
    consoleEntries.push({
      level: "page-error",
      message: String(webError.error()?.message || webError.error() || "Unknown page error").slice(0, MAX_MESSAGE_LENGTH),
      observedAt: Date.now(),
    });
  };
  context.on("response", onResponse);
  context.on("console", onConsole);
  context.on("weberror", onWebError);
  return {
    events,
    consoleEntries,
    dispose() {
      context.off("response", onResponse);
      context.off("console", onConsole);
      context.off("weberror", onWebError);
    },
  };
}

const CARDINALITIES = new Set(["exactly_one", "one_or_more", "zero", "optional"]);

function cardinalityOk(cardinality, count) {
  switch (cardinality) {
    case "exactly_one":
      return count === 1;
    case "one_or_more":
      return count >= 1;
    case "zero":
      return count === 0;
    case "optional":
      return true;
    default:
      throw new Error(`Unknown cardinality: ${cardinality}`);
  }
}

/**
 * Matches captured events against one resolved API contract
 * (apiContracts.resolveApprovedContract()'s return shape) and reports
 * whether the observed count satisfies the declared cardinality, and
 * whether every match actually conforms to the contract's request/response
 * schema (section 23: request validation + response validation).
 * Never fabricates a match: an event only counts if its host, method and
 * path genuinely match the contract's own path_template.
 */
export function correlateObservation({ contract, events, host, cardinality }) {
  if (!CARDINALITIES.has(cardinality)) throw new Error(`Unknown cardinality: ${cardinality}`);
  const matches = events.filter((event) => {
    let url;
    try {
      url = new URL(event.url);
    } catch {
      return false;
    }
    return url.hostname === host && event.method === contract.method && pathMatchesTemplate(url.pathname, contract.path_template);
  });
  const matchResults = matches.map((match) => {
    const statusOk = contract.expectedStatuses.includes(match.status);
    const requestErrors = contract.requestSchema ? validateShape(contract.requestSchema, match.requestBody ?? {}) : [];
    const responseErrors = validateResponseAgainstContract(contract.responseSchema, match.status, match.responseBody);
    const shapeErrors = [...requestErrors, ...responseErrors];
    return {
      status: match.status,
      requestSummary: summarizeBody(match.requestBody),
      responseSummary: summarizeBody(match.responseBody),
      contractMatch: statusOk && shapeErrors.length === 0,
      mismatchReason: !statusOk
        ? `Unexpected status ${match.status}; expected one of ${contract.expectedStatuses.join(", ")}.`
        : shapeErrors.length
          ? `Shape drift: ${shapeErrors.join("; ")}`
          : null,
    };
  });
  const observedCount = matches.length;
  const cardinalityMet = cardinalityOk(cardinality, observedCount);
  const allMatchesConform = matchResults.every((r) => r.contractMatch);
  let mismatchReason = null;
  if (!cardinalityMet)
    mismatchReason = `Expected ${cardinality.replaceAll("_", " ")} request(s) to ${contract.method} ${contract.path_template}, observed ${observedCount}.`;
  else if (!allMatchesConform) mismatchReason = matchResults.find((r) => r.mismatchReason)?.mismatchReason ?? null;
  return {
    observedCount,
    cardinalityOk: cardinalityMet,
    contractMatch: cardinalityMet && allMatchesConform,
    mismatchReason,
    matchResults,
  };
}
