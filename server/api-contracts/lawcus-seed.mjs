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

// V5 Step 15 — Contacts + Custom Fields. Observed for real against
// lohith.fiveriverz.com on 2026-09-16 (see server/core/contacts.mjs and
// the project memory note on that verification): a real Contact's
// custom_fields array, a real GET /contacts/:uuid read, and a real
// PUT /contacts/:uuid update that set one field's value and was
// confirmed round-tripped back in the response. Still OBSERVED_API, not
// DOCUMENTED — no official Lawcus API documentation exists for this
// endpoint either. Schemas only assert what was actually inspected:
// custom_fields' shape, id/uuid/name presence. Every other real field on
// the contact object (emails, phones, addresses, rates, ...) was seen but
// is deliberately left unconstrained rather than guessed at.
const CUSTOM_FIELD_VALUE_SCHEMA = {
  type: "object",
  required: ["teamCustomFieldId", "name", "value", "type"],
  properties: {
    teamCustomFieldId: { type: "number" },
    name: { type: "string" },
    value: { type: "string" },
    type: { type: "string" },
  },
};

export const CONTACTS_CONTRACTS = [
  {
    semanticId: "lawcus.contacts.read",
    featureName: "Contacts",
    featureDescription: "Person and Company contact records, shared with Leads (section 8's contacts.three-views).",
    operation: "Read one contact by UUID",
    method: "GET",
    pathTemplate: "/contacts/:uuid",
    responseSchema: {
      "200": {
        type: "object",
        required: ["id", "uuid", "name", "custom_fields"],
        properties: {
          id: { type: "number" },
          uuid: { type: "string" },
          name: { type: "string" },
          custom_fields: { type: "array", items: CUSTOM_FIELD_VALUE_SCHEMA },
        },
      },
    },
    expectedStatuses: [200],
    readWrite: "read",
    verificationRequirements: "custom_fields is read fresh before every update — never assumed from a prior response.",
    provenance: "OBSERVED_API",
    docSource: null,
    docVersion: null,
    docDate: null,
  },
  {
    semanticId: "lawcus.contacts.update",
    featureName: "Contacts",
    featureDescription: "Person and Company contact records, shared with Leads (section 8's contacts.three-views).",
    operation: "Update a contact, including its custom field values",
    method: "PUT",
    pathTemplate: "/contacts/:uuid",
    requestSchema: {
      type: "object",
      required: ["id", "custom_fields"],
      properties: {
        id: { type: "number" },
        custom_fields: {
          type: "array",
          items: {
            type: "object",
            required: ["team_custom_field_id", "value"],
            properties: { team_custom_field_id: { type: "number" }, value: { type: "string" } },
          },
        },
      },
    },
    responseSchema: {
      "200": {
        type: "object",
        required: ["id", "uuid", "custom_fields"],
        properties: {
          id: { type: "number" },
          uuid: { type: "string" },
          custom_fields: { type: "array", items: CUSTOM_FIELD_VALUE_SCHEMA },
        },
      },
    },
    expectedStatuses: [200],
    readWrite: "write",
    verificationRequirements:
      "The response's custom_fields must be re-checked for the exact value just sent (section 24: independent confirmation, not just a 200 status) before the mutation is trusted.",
    provenance: "OBSERVED_API",
    docSource: null,
    docVersion: null,
    docDate: null,
  },
  {
    semanticId: "lawcus.customfields.list",
    featureName: "Contact Custom Fields",
    featureDescription: "Custom field definitions, independently scoped per entity_type (CONTACT vs MATTER) — section 8's contact-custom-fields.independent-of-matter-custom-fields.",
    operation: "List all custom field definitions for the team",
    method: "GET",
    pathTemplate: "/v2/customfields",
    responseSchema: {
      "200": {
        type: "object",
        required: ["list"],
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "entity_type", "name", "type", "is_default", "is_required"],
              properties: {
                id: { type: "number" },
                entity_type: { type: "string" },
                name: { type: "string" },
                type: { type: "string" },
                is_default: { type: "boolean" },
                is_required: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    expectedStatuses: [200],
    readWrite: "read",
    verificationRequirements: "entity_type must be checked before treating a field as applicable to Contacts — the same list also carries MATTER-scoped fields.",
    provenance: "OBSERVED_API",
    docSource: null,
    docVersion: null,
    docDate: null,
  },
];

export function seedLawcusApiContracts(apiContracts) {
  for (const contract of [...AUTHENTICATION_CONTRACTS, ...CONTACTS_CONTRACTS]) apiContracts.proposeContract(contract);
}
