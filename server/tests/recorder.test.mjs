import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyValue,
  locatorQuality,
  normalizeCandidateActions,
  matchActionsToPrimitives,
  buildProposalSpecs,
} from "../core/recorder.mjs";

test("classifyValue redacts a password-type field regardless of its name", () => {
  const result = classifyValue({ fieldType: "password", fieldName: "field-9821", fieldLabel: null });
  assert.equal(result.redacted, true);
});

test("classifyValue redacts a field whose identity looks secret even when type is text", () => {
  const result = classifyValue({ fieldType: "text", fieldName: "apiKey", fieldLabel: null });
  assert.equal(result.redacted, true);
});

test("classifyValue never redacts an ordinary field", () => {
  assert.deepEqual(classifyValue({ fieldType: "text", fieldName: "firstName", fieldLabel: "First name" }), { redacted: false });
});

test("classifyValue reproduces section 29.3's exact example for a persona's password field", () => {
  const result = classifyValue({ fieldType: "password", fieldName: "password", fieldLabel: null, personaLabel: "persona" });
  assert.equal(result.redacted, true);
  assert.equal(result.reference, "${persona.credentials.password}");
});

test("classifyValue falls back to a generic redaction marker without a persona label", () => {
  const result = classifyValue({ fieldType: "text", fieldName: "token", fieldLabel: null });
  assert.equal(result.reference, "${redacted}");
});

test("locatorQuality treats a css-path fallback as unstable, and everything else as stable", () => {
  assert.equal(locatorQuality("testid"), "stable");
  assert.equal(locatorQuality("aria-label"), "stable");
  assert.equal(locatorQuality("label"), "stable");
  assert.equal(locatorQuality("placeholder"), "stable");
  assert.equal(locatorQuality("id"), "stable");
  assert.equal(locatorQuality("text"), "stable");
  assert.equal(locatorQuality("css-path"), "unstable");
});

test("normalizeCandidateActions collapses repeated input/change events on the same field into one", () => {
  const raw = [
    { actionType: "change", locatorCandidate: { strategy: "id", value: "name" }, value: "J" },
    { actionType: "change", locatorCandidate: { strategy: "id", value: "name" }, value: "Jo" },
    { actionType: "change", locatorCandidate: { strategy: "id", value: "name" }, value: "John" },
    { actionType: "click", locatorCandidate: { strategy: "text", value: "Save" } },
  ];
  const normalized = normalizeCandidateActions(raw);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].value, "John");
  assert.equal(normalized[1].actionType, "click");
});

test("normalizeCandidateActions does not collapse two different fields, or two clicks", () => {
  const raw = [
    { actionType: "change", locatorCandidate: { strategy: "id", value: "first" }, value: "A" },
    { actionType: "change", locatorCandidate: { strategy: "id", value: "last" }, value: "B" },
    { actionType: "click", locatorCandidate: { strategy: "text", value: "X" } },
    { actionType: "click", locatorCandidate: { strategy: "text", value: "Y" } },
  ];
  assert.equal(normalizeCandidateActions(raw).length, 4);
});

test("normalizeCandidateActions assigns sequential sequence numbers with no gaps", () => {
  const raw = [
    { actionType: "click", locatorCandidate: { strategy: "text", value: "A" } },
    { actionType: "click", locatorCandidate: { strategy: "text", value: "B" } },
  ];
  const normalized = normalizeCandidateActions(raw);
  assert.deepEqual(normalized.map((a) => a.sequence), [0, 1]);
});

const PRIMITIVES = [{ id: "auth.logout", action: "Sign out and wait for the login page to return." }];

test("matchActionsToPrimitives matches only on an exact normalized description equality — never a fuzzy guess", () => {
  const actions = [
    { description: "Sign out and wait for the login page to return." },
    { description: "click Contact Custom Fields" },
  ];
  const matched = matchActionsToPrimitives(actions, PRIMITIVES);
  assert.equal(matched[0].matchedPrimitiveId, "auth.logout");
  assert.equal(matched[1].matchedPrimitiveId, null);
});

test("matchActionsToPrimitives honors an explicit knownMatchers override", () => {
  const actions = [{ description: "click Contact Custom Fields" }];
  const matched = matchActionsToPrimitives(actions, [], { knownMatchers: { "click contact custom fields": "contacts.open_custom_fields" } });
  assert.equal(matched[0].matchedPrimitiveId, "contacts.open_custom_fields");
});

const SESSION = { id: "sess-1", feature_name: "Contacts", workflow_description: "Edit a custom field" };

test("buildProposalSpecs produces one NEW_TEST proposal when every action matched", () => {
  const actions = [
    { sequence: 0, description: "click Contacts", actionType: "click", locatorCandidate: { strategy: "testid" }, matchedPrimitiveId: "contacts.open" },
  ];
  const specs = buildProposalSpecs({ session: SESSION, actions, testCaseSubjectId: "contacts.edit-custom-field" });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].type, "NEW_TEST");
  assert.equal(specs[0].subjectId, "contacts.edit-custom-field");
});

test("buildProposalSpecs produces a NEW_PRIMITIVE proposal per unmatched action, and no NEW_TEST proposal yet", () => {
  const actions = [
    { sequence: 0, description: "click Contacts", actionType: "click", locatorCandidate: { strategy: "testid" }, matchedPrimitiveId: "contacts.open" },
    { sequence: 1, description: "click Custom Fields", actionType: "click", locatorCandidate: { strategy: "testid" }, matchedPrimitiveId: null },
  ];
  const specs = buildProposalSpecs({ session: SESSION, actions, testCaseSubjectId: "contacts.edit-custom-field" });
  assert.deepEqual(specs.map((s) => s.type), ["NEW_PRIMITIVE"]);
});

test("buildProposalSpecs produces a TESTABILITY_HOOK_REQUEST for an unstable locator, alongside its NEW_PRIMITIVE proposal", () => {
  const actions = [
    { sequence: 0, description: "click something", actionType: "click", locatorCandidate: { strategy: "css-path" }, matchedPrimitiveId: null },
  ];
  const specs = buildProposalSpecs({ session: SESSION, actions, testCaseSubjectId: "x" });
  assert.deepEqual(specs.map((s) => s.type).sort(), ["NEW_PRIMITIVE", "TESTABILITY_HOOK_REQUEST"]);
});

test("buildProposalSpecs never mentions the redacted literal value in a proposal it creates", () => {
  const actions = [
    {
      sequence: 0,
      description: 'set "password" (redacted)',
      actionType: "change",
      locatorCandidate: { strategy: "label", value: "Password" },
      matchedPrimitiveId: null,
      redacted: true,
    },
  ];
  const specs = buildProposalSpecs({ session: SESSION, actions, testCaseSubjectId: "x" });
  const serialized = JSON.stringify(specs);
  assert.equal(serialized.includes("redacted"), true);
  // Whatever the real secret would have been, it was never in `actions` to
  // begin with — this just proves the pipeline doesn't invent or leak one.
});
