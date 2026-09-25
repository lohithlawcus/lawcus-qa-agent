// What kind of failure was it? A failed check can mean very different things:
// Lawcus behaved differently than expected, or the environment/tooling could
// not run the check at all, or the check could not drive the page, or evidence
// could not be recorded. Only the first is a claim about the product; the
// others are reported as such and never counted as "Lawcus failed".
//
//   functional      The check ran and Lawcus's behavior did not match what was
//                   expected (a failed assertion, or an API answer that broke
//                   its approved contract).
//   infrastructure  The environment or our tooling could not run the check:
//                   login never completed, no browser, network or staging
//                   unavailable, rate-limited, credentials unavailable.
//   automation      The check could not drive the page, or our own safety
//                   policy blocked a request: an element never appeared, the
//                   client picker did not offer the contact, a create could
//                   not be confirmed. Either the product changed or the check
//                   needs repair; it does not prove the product is wrong.
//   integrity       Something we keep (an ownership record, evidence) could not
//                   be written. Not evidence about Lawcus.
//   unclassified    An error nobody has taught this module about. Never
//                   treated as a product failure, and shown as "needs a look".
//
// Rules are checked in order; the first match wins.

export const FAILURE_CLASSES = ["functional", "infrastructure", "automation", "integrity", "unclassified"];

export const CLASS_LABELS = {
  functional: "Lawcus behaved differently than expected",
  infrastructure: "could not run because of the environment or tooling",
  automation: "could not drive the page",
  integrity: "a record or evidence could not be saved",
  unclassified: "failed with an unrecognised error",
};

const RULES = [
  { pattern: /Also failed to record a possible leftover record/, failureClass: "integrity", reasonCode: "ownership_record_failed",
    explanation: "A record this check may have created could not be written to the local ownership list, so it may be missing from the leftovers report." },

  { pattern: /Live access \([^)]*\) is forbidden/i, failureClass: "infrastructure", reasonCode: "live_access_forbidden",
    explanation: "This process is not allowed to reach staging (a test-safety switch is on)." },
  { pattern: /Executable doesn't exist|browserType\.launch|Failed to launch|browser has been closed|Target page, context or browser has been closed/i, failureClass: "infrastructure", reasonCode: "browser_unavailable",
    explanation: "The test browser could not start or closed unexpectedly." },
  { pattern: /keychain|Invalid staging credentials|Save your staging account/i, failureClass: "infrastructure", reasonCode: "credentials_unavailable",
    explanation: "The saved staging account could not be read, so the check could not sign in." },
  { pattern: /getByPlaceholder\('Search your practice'/, failureClass: "infrastructure", reasonCode: "login_timeout",
    explanation: "Signing in to staging never reached the workspace in time. This is a login or environment problem, not a result about the feature under test." },

  { pattern: /net::ERR_BLOCKED_BY_CLIENT/, failureClass: "automation", reasonCode: "request_blocked_by_policy",
    explanation: "One of the page's own requests was blocked by this tool's safety policy. The policy may need a reviewed exception, or the page changed." },
  { pattern: /net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_\w+|TIMED_OUT|NETWORK_CHANGED|PROXY_\w+|TUNNEL_\w+|EMPTY_RESPONSE)|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i, failureClass: "infrastructure", reasonCode: "network_unreachable",
    explanation: "Staging could not be reached over the network." },
  { pattern: /Unexpected status (?:502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Time-?out/i, failureClass: "infrastructure", reasonCode: "staging_unavailable",
    explanation: "Staging answered that it was unavailable (502/503/504)." },
  { pattern: /Unexpected status 429\b|Too Many Requests|Three staging runs/i, failureClass: "infrastructure", reasonCode: "rate_limited",
    explanation: "Staging or the local run budget refused more requests for now." },

  { pattern: /Could not determine the created (\w+)'s uuid/, failureClass: "automation", reasonCode: "creation_unconfirmed",
    explanation: "Save/Create was clicked but Lawcus never confirmed a new record, so the record may or may not exist. It is listed as a possible leftover." },
  { pattern: /The Client picker never offered/, failureClass: "automation", reasonCode: "picker_option_missing",
    explanation: "The Client picker did not offer the contact to select. Nothing was selected." },
  { pattern: /(?:locator|page|frame|elementHandle)\.\w+: Timeout \d+ms exceeded|waiting for (?:locator|getBy)|strict mode violation|Element is not (?:editable|visible|enabled|stable)|element is not stable|intercepts pointer events|outside of the viewport/i, failureClass: "automation", reasonCode: "ui_step_failed",
    explanation: "The check could not complete a step on the page (an element did not appear or could not be used). The page may have changed, or the check needs repair; this alone does not show Lawcus is wrong." },
  { pattern: /Timeout \d+ms exceeded/i, failureClass: "automation", reasonCode: "ui_step_timeout",
    explanation: "A step on the page took longer than allowed." },
];

const FUNCTIONAL_CONTRACT = /contract|Shape drift|Unexpected status|request\(s\) to (?:GET|POST|PUT|PATCH|DELETE)/i;

function fromRule(rule) {
  return { failureClass: rule.failureClass, reasonCode: rule.reasonCode, explanation: rule.explanation };
}

/** An error thrown by a check (it could not finish). Anything unrecognised is
 * "unclassified" — never a claim about the product. */
export function classifyThrown(error) {
  const text = String(error?.message ?? error ?? "");
  const rule = RULES.find((candidate) => candidate.pattern.test(text));
  if (rule) return fromRule(rule);
  return {
    failureClass: "unclassified",
    reasonCode: "unclassified_error",
    explanation: "The check stopped with an error this tool does not recognise. It needs a look before anything is concluded about Lawcus.",
  };
}

/** A check that finished and reported "not passed". Its reason text is checked
 * for infrastructure signs first (a create can "fail" because staging answered
 * 502); otherwise the product did not match what was expected. */
export function classifyReportedFailure(reason) {
  const text = String(reason ?? "");
  const rule = RULES.find((candidate) => candidate.pattern.test(text));
  if (rule) return fromRule(rule);
  if (FUNCTIONAL_CONTRACT.test(text)) {
    return { failureClass: "functional", reasonCode: "contract_mismatch", explanation: "Lawcus answered, but not the way its approved contract says it should." };
  }
  return { failureClass: "functional", reasonCode: "assertion_failed", explanation: "The check ran and Lawcus's behavior did not match what was expected." };
}

/** Counts of not-passed results by class; a result with no class (older
 * results, or callers that predate classification) counts as functional so
 * existing behavior is unchanged. */
export function countByClass(failedResults) {
  const counts = {};
  for (const result of failedResults) {
    const failureClass = FAILURE_CLASSES.includes(result.failureClass) ? result.failureClass : "functional";
    counts[failureClass] = (counts[failureClass] || 0) + 1;
  }
  return counts;
}
