import test from "node:test";
import assert from "node:assert/strict";
import { pathMatchesTemplate, correlateObservation } from "../core/network-observer.mjs";

test("pathMatchesTemplate matches an exact path with no parameters", () => {
  assert.equal(pathMatchesTemplate("/login", "/login"), true);
  assert.equal(pathMatchesTemplate("/login/extra", "/login"), false);
  assert.equal(pathMatchesTemplate("/logi", "/login"), false);
});

test("pathMatchesTemplate matches a :param segment against any single path segment", () => {
  assert.equal(pathMatchesTemplate("/contacts/123", "/contacts/:id"), true);
  assert.equal(pathMatchesTemplate("/contacts/123/notes", "/contacts/:id"), false);
  assert.equal(pathMatchesTemplate("/contacts/123/notes", "/contacts/:id/notes"), true);
});

const CONTRACT = {
  method: "POST",
  path_template: "/login",
  requestSchema: { type: "object", required: ["email", "password"], properties: { email: { type: "string" } } },
  responseSchema: {
    "200": { type: "object" },
    "403": { type: "object", required: ["error"], properties: { error: { type: "string" } } },
  },
  expectedStatuses: [200, 403],
};

function event({ method = "POST", url = "https://api.example.test/login", status = 200, requestBody = { email: "a@b.test", password: "x" }, responseBody = {} } = {}) {
  return { method, url, status, requestBody, responseBody, observedAt: Date.now() };
}

test("exactly_one is satisfied by one matching, conforming event", () => {
  const result = correlateObservation({
    contract: CONTRACT,
    events: [event()],
    host: "api.example.test",
    cardinality: "exactly_one",
  });
  assert.equal(result.observedCount, 1);
  assert.equal(result.cardinalityOk, true);
  assert.equal(result.contractMatch, true);
  assert.equal(result.mismatchReason, null);
});

test("exactly_one fails closed when the expected request never happened (section 23: report failure/review)", () => {
  const result = correlateObservation({ contract: CONTRACT, events: [], host: "api.example.test", cardinality: "exactly_one" });
  assert.equal(result.observedCount, 0);
  assert.equal(result.cardinalityOk, false);
  assert.equal(result.contractMatch, false);
  assert.match(result.mismatchReason, /observed 0/);
});

test("zero fails when an unexpected request is observed", () => {
  const result = correlateObservation({ contract: CONTRACT, events: [event()], host: "api.example.test", cardinality: "zero" });
  assert.equal(result.cardinalityOk, false);
  assert.equal(result.observedCount, 1);
});

test("zero passes when nothing was observed", () => {
  const result = correlateObservation({ contract: CONTRACT, events: [], host: "api.example.test", cardinality: "zero" });
  assert.equal(result.cardinalityOk, true);
  assert.equal(result.contractMatch, true);
});

test("wrong request cardinality is detected for exactly_one with two matches", () => {
  const result = correlateObservation({
    contract: CONTRACT,
    events: [event(), event({ status: 403, responseBody: { error: "nope" } })],
    host: "api.example.test",
    cardinality: "exactly_one",
  });
  assert.equal(result.observedCount, 2);
  assert.equal(result.cardinalityOk, false);
});

test("one_or_more is satisfied by any nonzero count", () => {
  assert.equal(
    correlateObservation({ contract: CONTRACT, events: [event(), event()], host: "api.example.test", cardinality: "one_or_more" }).cardinalityOk,
    true,
  );
  assert.equal(
    correlateObservation({ contract: CONTRACT, events: [], host: "api.example.test", cardinality: "one_or_more" }).cardinalityOk,
    false,
  );
});

test("optional is always satisfied regardless of count", () => {
  assert.equal(correlateObservation({ contract: CONTRACT, events: [], host: "api.example.test", cardinality: "optional" }).cardinalityOk, true);
  assert.equal(
    correlateObservation({ contract: CONTRACT, events: [event(), event()], host: "api.example.test", cardinality: "optional" }).cardinalityOk,
    true,
  );
});

test("events from a different host, method or path never count toward correlation (no fuzzy matching, section 23)", () => {
  const result = correlateObservation({
    contract: CONTRACT,
    events: [
      event({ url: "https://other.example.test/login" }),
      event({ method: "GET" }),
      event({ url: "https://api.example.test/logout" }),
    ],
    host: "api.example.test",
    cardinality: "exactly_one",
  });
  assert.equal(result.observedCount, 0);
});

test("an unexpected status on an otherwise-matching request is a contract mismatch, not a cardinality failure", () => {
  const result = correlateObservation({
    contract: CONTRACT,
    events: [event({ status: 500, responseBody: { error: "boom" } })],
    host: "api.example.test",
    cardinality: "exactly_one",
  });
  assert.equal(result.observedCount, 1);
  assert.equal(result.cardinalityOk, true);
  assert.equal(result.contractMatch, false);
  assert.match(result.mismatchReason, /Unexpected status 500/);
});

test("a response whose body does not match the contract's schema for that status is a shape mismatch", () => {
  const result = correlateObservation({
    contract: CONTRACT,
    events: [event({ status: 403, responseBody: {} })],
    host: "api.example.test",
    cardinality: "exactly_one",
  });
  assert.equal(result.contractMatch, false);
  assert.match(result.mismatchReason, /Shape drift/);
});

test("an unknown cardinality throws rather than silently passing", () => {
  assert.throws(() => correlateObservation({ contract: CONTRACT, events: [], host: "api.example.test", cardinality: "sometimes" }));
});
