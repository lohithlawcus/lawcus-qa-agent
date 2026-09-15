import test from "node:test";
import assert from "node:assert/strict";
import { validateShape, validateResponseAgainstContract } from "../core/schema-shape.mjs";

test("a value matching an object schema's required/typed fields has no errors", () => {
  const schema = {
    type: "object",
    required: ["email", "password"],
    properties: { email: { type: "string" }, password: { type: "string" } },
  };
  assert.deepEqual(validateShape(schema, { email: "a@b.test", password: "x" }), []);
});

test("a missing required field is reported", () => {
  const schema = { type: "object", required: ["email"], properties: { email: { type: "string" } } };
  const errors = validateShape(schema, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /email.*required/);
});

test("a wrong-typed field is reported, and an unlisted extra field is not (section: response mismatch fails, not a closed shape)", () => {
  const schema = { type: "object", required: ["email"], properties: { email: { type: "string" } } };
  assert.equal(validateShape(schema, { email: 12345 }).length, 1);
  assert.deepEqual(validateShape(schema, { email: "a", extra: "unlisted-but-fine" }), []);
});

test("nested object and array schemas validate recursively", () => {
  const schema = {
    type: "object",
    required: ["items"],
    properties: {
      items: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    },
  };
  assert.deepEqual(validateShape(schema, { items: [{ id: "1" }, { id: "2" }] }), []);
  const errors = validateShape(schema, { items: [{ id: "1" }, {}] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /items\[1\]\.id/);
});

test("integer type rejects a non-integer number; number type accepts both", () => {
  assert.deepEqual(validateShape({ type: "integer" }, 3), []);
  assert.equal(validateShape({ type: "integer" }, 3.5).length, 1);
  assert.deepEqual(validateShape({ type: "number" }, 3.5), []);
});

test("nullable fields accept null without error; non-nullable fields reject it", () => {
  assert.deepEqual(validateShape({ type: "string", nullable: true }, null), []);
  assert.equal(validateShape({ type: "string" }, null).length, 1);
});

test("validateResponseAgainstContract selects the schema keyed by the exact status, falling back to default, then to no assertion", () => {
  const byStatus = {
    "200": { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    default: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
  };
  assert.deepEqual(validateResponseAgainstContract(byStatus, 200, { ok: true }), []);
  assert.equal(validateResponseAgainstContract(byStatus, 200, {}).length, 1);
  assert.deepEqual(validateResponseAgainstContract(byStatus, 500, { error: "boom" }), []);
  assert.deepEqual(validateResponseAgainstContract({}, 500, { anything: true }), []);
});
