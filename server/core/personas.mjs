import { randomUUID } from "node:crypto";
import { z } from "zod";
import { now } from "./store.mjs";

const PERSONA_ACCOUNTS = ["lawcus-persona-admin", "lawcus-persona-member", "lawcus-persona-co-counsel", "lawcus-persona-custom"];
export const PersonaRegistration = z
  .object({
    environmentId: z.enum(["fixture", "lawcus"]),
    role: z.enum(["admin", "member", "co_counsel", "custom"]),
    label: z.string().trim().min(1).max(80),
    credentialAccount: z.enum(PERSONA_ACCOUNTS),
  })
  .strict();

// V5 Step 12 / section 18 — Persona Session Foundation.
//
// This is deliberately NOT structured like Knowledge/Proposals' human-
// approval discipline (propose -> a separate click approves). A persona's
// trust comes from actually, verifiably signing in as it — there is no
// content here for a human to review and judge; there's only "did this
// identity really authenticate." markVerified() is called exactly once,
// by the interactive visible sign-in flow (live-runner.mjs's
// verifyPersonaInBrowser(), mirroring connectInBrowser()) after Playwright
// itself confirmed the resulting account's identity — never by a bare API
// call, and never by anything claiming to be "AI-verified."

export class PersonaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ROLES = new Set(["admin", "member", "co_counsel", "custom"]);

export function openPersonas(db, audit) {
  /** Registering a persona only reserves an identity slot + names which
   * Keychain account will hold its credential — it starts pending_verification
   * and stays useless (resolveVerifiedPersona() fails closed) until a real
   * sign-in proves it. Idempotent on credential_account: re-registering the
   * same Keychain account returns the existing row rather than duplicating it. */
  function registerPersona({ environmentId, role, label, credentialAccount }) {
    if (!ROLES.has(role)) throw new PersonaError("unknown_role", `Unknown persona role: ${role}`);
    const existing = db.prepare("SELECT * FROM personas WHERE credential_account=?").get(credentialAccount);
    if (existing) return existing;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO personas(id,environment_id,role,label,credential_account,status,session_status,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(id, environmentId, role, label, credentialAccount, "pending_verification", "none", now());
    audit?.("persona.registered", id, { environmentId, role, label });
    return db.prepare("SELECT * FROM personas WHERE id=?").get(id);
  }

  function markVerified(id, { username, verifiedBy }) {
    if (!username || typeof username !== "string")
      throw new PersonaError("no_identity", "A confirmed username is required to verify a persona.");
    const result = db
      .prepare(
        "UPDATE personas SET status='verified',expected_username=?,verified_by=?,verified_at=? WHERE id=? AND status IN ('pending_verification','revoked')",
      )
      .run(username, verifiedBy, now(), id);
    if (!result.changes)
      throw new PersonaError("not_pending", "This persona is not awaiting verification.");
    audit?.("persona.verified", id, { username, verifiedBy });
    return db.prepare("SELECT * FROM personas WHERE id=?").get(id);
  }

  function revoke(id, { revokedBy, reason }) {
    const result = db
      .prepare("UPDATE personas SET status='revoked',session_status='revoked' WHERE id=? AND status='verified'")
      .run(id);
    if (!result.changes) throw new PersonaError("not_verified", "Only a verified persona can be revoked.");
    audit?.("persona.revoked", id, { revokedBy, reason });
    return db.prepare("SELECT * FROM personas WHERE id=?").get(id);
  }

  /** Fails closed: nothing outside this module may use a persona that
   * isn't currently verified, no matter how it got that way. */
  function resolveVerifiedPersona(id) {
    const row = db.prepare("SELECT * FROM personas WHERE id=? AND status='verified'").get(id);
    if (!row) throw new PersonaError("not_verified", `Persona "${id}" is not verified.`);
    return row;
  }

  function recordSessionCaptured(id) {
    const result = db
      .prepare("UPDATE personas SET session_status='active',session_captured_at=? WHERE id=? AND status='verified'")
      .run(now(), id);
    if (!result.changes) throw new PersonaError("not_verified", "Only a verified persona can hold a session.");
    audit?.("persona.session.captured", id, {});
  }

  function invalidateSession(id, reason) {
    db.prepare("UPDATE personas SET session_status='expired' WHERE id=?").run(id);
    audit?.("persona.session.invalidated", id, { reason });
  }

  function list() {
    return db.prepare("SELECT * FROM personas ORDER BY created_at").all();
  }

  function get(id) {
    return db.prepare("SELECT * FROM personas WHERE id=?").get(id);
  }

  return {
    registerPersona,
    markVerified,
    revoke,
    resolveVerifiedPersona,
    recordSessionCaptured,
    invalidateSession,
    list,
    get,
  };
}
