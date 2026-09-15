-- V5 Step 12 / section 18 — Persona Session Foundation.
--
-- personas: a controlled QA identity (section 18: "Owner / Admin /
-- Attorney-member / Restricted custom role / API QA service persona").
-- Deliberately separate from `environments.execution_enabled`-style trust:
-- a persona only becomes usable once `status='verified'` — and the only
-- way to reach that status is a real interactive visible sign-in that
-- confirms the resulting identity (see server/core/live-runner.mjs's
-- verifyPersonaInBrowser()), never a self-reported claim. No password or
-- session content is ever stored on this row — credential_account only
-- names which macOS Keychain entry holds it (section 18.1).
CREATE TABLE personas(
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  role TEXT NOT NULL CHECK(role IN ('admin','member','co_counsel','custom')),
  label TEXT NOT NULL,
  credential_account TEXT NOT NULL UNIQUE,
  expected_username TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending_verification','verified','revoked')),
  verified_by TEXT,
  verified_at TEXT,
  -- session_status tracks the *encrypted storageState file* on disk
  -- (server/core/persona-session.mjs), not the persona's own trust —
  -- 'none' until a real sign-in captures one, 'expired'/'revoked' force
  -- the next use back through a fresh interactive login (section 18: "may
  -- require fresh browser state").
  session_status TEXT NOT NULL DEFAULT 'none' CHECK(session_status IN ('none','active','expired','revoked')),
  session_captured_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX personas_environment_idx ON personas(environment_id, status);
