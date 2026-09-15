import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { sealEvidence, openEvidence } from "./setup.mjs";

// V5 Step 12 / section 18.1 — Storage-state security.
//
// A persona's authenticated Playwright storageState (cookies + localStorage
// — genuinely sensitive session material) is never written to disk in the
// clear, never committed, never returned over HTTP, and never printed by
// anything in this codebase. It reuses the exact AES-256-GCM scheme
// already reviewed for encrypted evidence (setup.mjs's sealEvidence/
// openEvidence, keyed by the same Keychain-held artifact-key) rather than
// inventing a second encryption path. One file per persona, overwritten on
// each fresh capture — there is no history of old sessions to leak.

function statePath(directory, personaId) {
  return join(directory, "personas", `${personaId}.state.enc`);
}

export async function savePersonaState(directory, personaId, storageState, { keyLoader } = {}) {
  const dir = join(directory, "personas");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const plaintext = Buffer.from(JSON.stringify(storageState));
  const sealed = await sealEvidence(plaintext, keyLoader ? { keyLoader } : {});
  plaintext.fill(0);
  writeFileSync(statePath(directory, personaId), sealed, { mode: 0o600 });
}

/** Returns null (not an error) when no session has ever been captured, or
 * it was deliberately invalidated — callers should treat that as "fall
 * back to a fresh interactive login," matching section 18's "fresh-login
 * option," not as a failure. */
export async function loadPersonaState(directory, personaId, { keyLoader } = {}) {
  const path = statePath(directory, personaId);
  if (!existsSync(path)) return null;
  const sealed = readFileSync(path);
  const plaintext = await openEvidence(sealed, keyLoader ? { keyLoader } : {});
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    plaintext.fill(0);
  }
}

export function deletePersonaState(directory, personaId) {
  const path = statePath(directory, personaId);
  if (existsSync(path)) unlinkSync(path);
}
