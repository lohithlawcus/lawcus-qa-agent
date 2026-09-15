import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { savePersonaState, loadPersonaState, deletePersonaState } from "../core/persona-session.mjs";

// A fake key, injected the same way setup.mjs's own sealEvidence/
// openEvidence tests would — no real macOS Keychain access needed.
const fakeKey = randomBytes(32).toString("base64");
const keyLoader = async (account) => {
  if (account !== "artifact-key") throw new Error("Unexpected key account.");
  return fakeKey;
};

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-persona-session-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATE = { cookies: [{ name: "session", value: "opaque-token-value" }], origins: [] };

test("save then load round-trips the exact storage state", async () => {
  await withDir(async (dir) => {
    await savePersonaState(dir, "persona-1", STATE, { keyLoader });
    const loaded = await loadPersonaState(dir, "persona-1", { keyLoader });
    assert.deepEqual(loaded, STATE);
  });
});

test("loadPersonaState returns null (not an error) when nothing was ever captured", () => {
  return withDir(async (dir) => {
    assert.equal(await loadPersonaState(dir, "never-captured", { keyLoader }), null);
  });
});

test("the file on disk is encrypted, not plaintext JSON (section 18.1)", () => {
  return withDir(async (dir) => {
    await savePersonaState(dir, "persona-1", STATE, { keyLoader });
    const raw = readFileSync(join(dir, "personas", "persona-1.state.enc"));
    assert.equal(raw.includes("opaque-token-value"), false);
    assert.equal(raw.subarray(0, 4).toString(), "LQA1");
  });
});

test("the persona directory and state file use restrictive permissions", () => {
  return withDir(async (dir) => {
    await savePersonaState(dir, "persona-1", STATE, { keyLoader });
    const fileMode = statSync(join(dir, "personas", "persona-1.state.enc")).mode & 0o777;
    const dirMode = statSync(join(dir, "personas")).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  });
});

test("saving again overwrites the previous state (no history of old sessions)", () => {
  return withDir(async (dir) => {
    await savePersonaState(dir, "persona-1", STATE, { keyLoader });
    const updated = { cookies: [{ name: "session", value: "a-newer-token" }], origins: [] };
    await savePersonaState(dir, "persona-1", updated, { keyLoader });
    assert.deepEqual(await loadPersonaState(dir, "persona-1", { keyLoader }), updated);
  });
});

test("deletePersonaState removes the file; loading afterward returns null", () => {
  return withDir(async (dir) => {
    await savePersonaState(dir, "persona-1", STATE, { keyLoader });
    deletePersonaState(dir, "persona-1");
    assert.equal(await loadPersonaState(dir, "persona-1", { keyLoader }), null);
  });
});

test("deletePersonaState on a persona with no saved state is a no-op, not an error", () => {
  return withDir((dir) => {
    assert.doesNotThrow(() => deletePersonaState(dir, "never-had-one"));
  });
});

test("a wrong key cannot decrypt another persona's sealed state", () => {
  return withDir(async (dir) => {
    await savePersonaState(dir, "persona-1", STATE, { keyLoader });
    const wrongKeyLoader = async () => randomBytes(32).toString("base64");
    await assert.rejects(loadPersonaState(dir, "persona-1", { keyLoader: wrongKeyLoader }));
  });
});
