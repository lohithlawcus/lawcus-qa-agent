import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePrimitive,
  listPrimitives,
  evaluatePrimitiveTrust,
  computeImplementationHash,
  PrimitiveError,
} from "../core/primitives.mjs";

const REGISTERED_IDS = [
  "auth.open_login_page",
  "auth.ensure_login_fields",
  "auth.resolve_submit_control",
  "auth.assert_password_masked",
  "auth.assert_empty_fields_blocked",
  "auth.fill_credentials",
  "auth.assert_invalid_credentials_rejected",
  "auth.assert_authenticated_workspace",
  "auth.logout",
  "auth.assert_protected_route_blocked",
];

test("every registered login primitive currently resolves (source matches its approved hash)", () => {
  for (const id of REGISTERED_IDS) {
    const primitive = resolvePrimitive(id);
    assert.equal(primitive.id, id);
    assert.equal(typeof primitive.run, "function");
  }
});

test("listPrimitives reports exactly the registered set and never leaks implementations or hashes", () => {
  const listed = listPrimitives();
  assert.deepEqual(
    listed.map((p) => p.id).sort(),
    [...REGISTERED_IDS].sort(),
  );
  for (const p of listed) {
    assert.equal("impl" in p, false);
    assert.equal("approvedHash" in p, false);
  }
});

test("an unknown primitive id fails closed", () => {
  assert.throws(
    () => resolvePrimitive("auth.does_not_exist"),
    (e) => e instanceof PrimitiveError && e.code === "unknown_primitive",
  );
});

test("computeImplementationHash throws for an unknown id", () => {
  assert.throws(() => computeImplementationHash("auth.does_not_exist"));
});

test("section 12: unknown, pending, deprecated and hash-mismatched primitives all fail closed", () => {
  assert.deepEqual(evaluatePrimitiveTrust(undefined, "any"), {
    trusted: false,
    reason: "unknown_primitive",
  });
  assert.deepEqual(
    evaluatePrimitiveTrust({ status: "pending_review", approvedHash: "a" }, "a"),
    { trusted: false, reason: "not_approved" },
  );
  assert.deepEqual(
    evaluatePrimitiveTrust({ status: "deprecated", approvedHash: "a" }, "a"),
    { trusted: false, reason: "deprecated_primitive" },
  );
  assert.deepEqual(
    evaluatePrimitiveTrust({ status: "approved", approvedHash: "a" }, "b"),
    { trusted: false, reason: "hash_mismatch" },
  );
  assert.deepEqual(
    evaluatePrimitiveTrust({ status: "approved", approvedHash: "a" }, "a"),
    { trusted: true },
  );
});
