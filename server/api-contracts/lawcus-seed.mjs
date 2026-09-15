// V5 Step 10 seed data for the API Contract Registry.
//
// No official Lawcus API documentation has been supplied to this project
// yet (the operator's Articles folder — server/knowledge/lawcus-seed.mjs's
// source — is end-user support content, not API documentation). Inventing
// endpoint paths, methods or schemas from guesswork is exactly what section
// 19 forbids, so this seed proposes exactly one contract, and its
// provenance is honestly OBSERVED_API, not DOCUMENTED: every field below
// is taken only from what this project has already implemented and tested
// against the real staging host (server/core/live-runner.mjs's
// permitLiveRequest()/runLive(), in production in this codebase since
// Step 4) — not from a written spec. It still goes through the identical
// pending_review -> human approval gate as a DOCUMENTED contract would; an
// OBSERVED_API contract carries no extra trust for having come from real
// traffic (section 19: "It must not automatically become an approved API
// contract.").
//
// When the operator supplies real Lawcus API documentation (matching how
// Step 9 was supplied real support articles), further contracts should be
// proposed here with provenance DOCUMENTED and a real docSource.

export const AUTHENTICATION_CONTRACTS = [
  {
    semanticId: "lawcus.auth.login",
    featureName: "Authentication",
    featureDescription: "Sign in, sign out, and session behavior for the Lawcus workspace.",
    operation: "Authenticate with email and password",
    method: "POST",
    pathTemplate: "/login",
    requestSchema: {
      type: "object",
      required: ["email", "password"],
      properties: { email: { type: "string" }, password: { type: "string" } },
    },
    // Only the rejected-credentials shape has actually been inspected in
    // this codebase (live-runner.mjs reads response.error on a >=400
    // response). The 200 success-response body has never been parsed here
    // — runLive() confirms authentication through the resulting browser
    // session, not by reading the /login response JSON — so this contract
    // makes no claim about its shape beyond "an object", rather than
    // inventing one.
    responseSchema: {
      "200": { type: "object" },
      "400": { type: "object", required: ["error"], properties: { error: { type: "string" } } },
      "401": { type: "object", required: ["error"], properties: { error: { type: "string" } } },
      "403": { type: "object", required: ["error"], properties: { error: { type: "string" } } },
    },
    expectedStatuses: [200, 400, 401, 403],
    errorContract: { statusField: "status", messageField: "error" },
    readWrite: "write",
    verificationRequirements:
      "Status must be read explicitly from the response (never inferred from the resulting UI alone, section 3.3). A non-200 response must not be treated as a partial success.",
    provenance: "OBSERVED_API",
    docSource: null,
    docVersion: null,
    docDate: null,
  },
];

export function seedLawcusApiContracts(apiContracts) {
  for (const contract of AUTHENTICATION_CONTRACTS) apiContracts.proposeContract(contract);
}
