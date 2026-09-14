// V5 Step 7 / section 32 — Local Intent Router.
//
// Pipeline: normalize -> known alias/entity lookup -> TestBook match ->
// confidence decision. There is no Impact Graph or Knowledge Base yet
// (Steps 9+), so this only covers what actually exists right now: the
// single Authentication / login-essentials suite. Step 16 generalizes this
// into the full Impact-Graph-driven version described in section 32.

export function normalizeIntent(text) {
  return text.trim().replace(/\s+/g, " ");
}

// The same recognized-phrasing boundary contracts.mjs's builtInPlan()
// already enforces for the fixture environment — kept here as the single
// definition of "a known login-test request" so both environments agree
// on what counts as locally resolvable.
const LOGIN_INTENT = /^(test|check|regression test|thoroughly test|retest)\s+(the\s+)?(login(\s+page)?|sign[ -]?in)(\s+(thoroughly|again))?[.!]?$/i;

const KNOWN_PATTERNS = [
  {
    featureName: "Authentication",
    suiteName: "login-essentials",
    test: (normalized) => LOGIN_INTENT.test(normalized),
  },
];

// Live Lawcus staging never authorizes invalid_password by default —
// account lockout limits aren't confirmed (same policy already enforced in
// ai-planner.mjs and live-runner.mjs's negativeAllowed=false). The
// TestBook's case list doesn't know about that environment-specific
// restriction, so the router applies it explicitly.
const EXTERNAL_ID_TO_SCENARIO = {
  "auth.password_masked": "password_masked",
  "auth.empty_fields": "empty_fields",
  "auth.valid_login": "valid_login",
  "auth.invalid_password": "invalid_password",
  "auth.logout": "logout",
};

export function resolveIntent({ intent, testbook, environmentId }) {
  const normalizedIntent = normalizeIntent(intent);
  const unmatched = {
    normalizedIntent,
    matched: false,
    confidence: 0,
    featureId: null,
    suiteId: null,
    caseIds: [],
    scenarios: [],
  };
  const pattern = KNOWN_PATTERNS.find((p) => p.test(normalizedIntent));
  if (!pattern) return unmatched;

  const feature = testbook
    .tree()
    .find((f) => f.name === pattern.featureName);
  const suite = feature?.suites.find((s) => s.name === pattern.suiteName);
  if (!suite) return unmatched; // Not in the TestBook yet — fall through to AI.

  const approvedCases = suite.cases.filter((c) => c.status === "approved");
  const recognized = approvedCases.filter(
    (c) => EXTERNAL_ID_TO_SCENARIO[c.externalId],
  );
  const excluded =
    environmentId === "lawcus"
      ? new Set(["invalid_password"])
      : new Set();
  const usableCases = recognized.filter(
    (c) => !excluded.has(EXTERNAL_ID_TO_SCENARIO[c.externalId]),
  );
  const scenarios = usableCases.map((c) => EXTERNAL_ID_TO_SCENARIO[c.externalId]);
  if (!scenarios.length) return unmatched;

  return {
    normalizedIntent,
    matched: true,
    // Full confidence only when every case in the suite is both approved
    // and recognized — nothing was silently dropped for an unrelated
    // reason (unapproved status, an unmapped external id). The
    // environment-specific exclusion above is a deliberate policy
    // decision, not a gap, so it doesn't reduce confidence on its own.
    confidence: approvedCases.length === suite.cases.length &&
      recognized.length === approvedCases.length
        ? 1
        : 0.7,
    featureId: feature.id,
    suiteId: suite.id,
    caseIds: usableCases.map((c) => c.id),
    scenarios,
  };
}
