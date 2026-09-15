import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openPersonas, PersonaError } from "../core/personas.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-personas-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openPersonas(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = { environmentId: "lawcus", role: "admin", label: "QA Admin", credentialAccount: "lawcus-persona-admin" };

test("registerPersona creates a pending_verification persona, idempotent on credential_account", () => {
  withStore((personas) => {
    const p = personas.registerPersona(BASE);
    assert.equal(p.status, "pending_verification");
    assert.equal(p.session_status, "none");
    const again = personas.registerPersona(BASE);
    assert.equal(again.id, p.id);
    assert.equal(personas.list().length, 1);
  });
});

test("registerPersona rejects an unknown role", () => {
  withStore((personas) => {
    assert.throws(
      () => personas.registerPersona({ ...BASE, role: "owner", credentialAccount: "x" }),
      (e) => e instanceof PersonaError && e.code === "unknown_role",
    );
  });
});

test("resolveVerifiedPersona fails closed until markVerified is called with a confirmed identity", () => {
  withStore((personas) => {
    const p = personas.registerPersona(BASE);
    assert.throws(
      () => personas.resolveVerifiedPersona(p.id),
      (e) => e instanceof PersonaError && e.code === "not_verified",
    );
    assert.throws(
      () => personas.markVerified(p.id, { username: "", verifiedBy: "operator:test" }),
      (e) => e instanceof PersonaError && e.code === "no_identity",
    );
    const verified = personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" });
    assert.equal(verified.status, "verified");
    assert.equal(verified.expected_username, "admin@qa.test");
    assert.equal(personas.resolveVerifiedPersona(p.id).id, p.id);
  });
});

test("markVerified cannot be called twice on an already-verified persona", () => {
  withStore((personas) => {
    const p = personas.registerPersona(BASE);
    personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" });
    assert.throws(
      () => personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" }),
      (e) => e instanceof PersonaError && e.code === "not_pending",
    );
  });
});

test("revoke requires a currently-verified persona, and revoking also expires its session", () => {
  withStore((personas) => {
    const p = personas.registerPersona(BASE);
    assert.throws(
      () => personas.revoke(p.id, { revokedBy: "operator:test", reason: "left the firm" }),
      (e) => e instanceof PersonaError && e.code === "not_verified",
    );
    personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" });
    personas.recordSessionCaptured(p.id);
    const revoked = personas.revoke(p.id, { revokedBy: "operator:test", reason: "left the firm" });
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.session_status, "revoked");
    assert.throws(() => personas.resolveVerifiedPersona(p.id));
  });
});

test("recordSessionCaptured requires a verified persona; invalidateSession works regardless of status", () => {
  withStore((personas) => {
    const p = personas.registerPersona(BASE);
    assert.throws(
      () => personas.recordSessionCaptured(p.id),
      (e) => e instanceof PersonaError && e.code === "not_verified",
    );
    personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" });
    personas.recordSessionCaptured(p.id);
    assert.equal(personas.list()[0].session_status, "active");
    personas.invalidateSession(p.id, "stale");
    assert.equal(personas.list()[0].session_status, "expired");
  });
});

test("a revoked persona can be re-verified later (e.g. after credentials are refreshed)", () => {
  withStore((personas) => {
    const p = personas.registerPersona(BASE);
    personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" });
    personas.revoke(p.id, { revokedBy: "operator:test", reason: "rotated" });
    const reverified = personas.markVerified(p.id, { username: "admin@qa.test", verifiedBy: "operator:test" });
    assert.equal(reverified.status, "verified");
  });
});
