-- V5 Step 13 / sections 25-28 — Test Data Ownership, Resource Lock
-- Manager, Mutation/Restoration Journal, Cleanup.

-- resource_ownership: every resource a run CREATES (section 25). Exact
-- server IDs, not name prefixes, are the only cleanup authority — see the
-- UNIQUE constraint below, which makes it structurally impossible for two
-- rows to both claim ownership of the same real object.
CREATE TABLE resource_ownership(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  -- Self-reference for dependency order (section 28: "reverse dependency
  -- order") — e.g. a Contact Note owned by a Contact: the note's row
  -- points at the contact's row, so cleanup deletes the note first.
  parent_resource_id TEXT REFERENCES resource_ownership(id),
  created_by_primitive TEXT NOT NULL,
  display_name TEXT,
  cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('auto','manual','retain')),
  cleanup_status TEXT NOT NULL CHECK(cleanup_status IN ('pending','cleaned','already_missing','failed','skipped')) DEFAULT 'pending',
  cleanup_note TEXT,
  cleaned_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(environment_id, resource_type, resource_id)
);
CREATE INDEX resource_ownership_run_idx ON resource_ownership(run_id);

-- resource_locks: semantic Core locks over shared/global configuration
-- (section 26) — e.g. "tenant:x:custom-fields:contact". The partial
-- unique index is the actual exclusivity mechanism: SQLite refuses a
-- second 'held' row for the same lock_key outright, so "conflicting
-- writes never execute concurrently" is enforced by the database itself,
-- not by application-level care.
CREATE TABLE resource_locks(
  id TEXT PRIMARY KEY,
  lock_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  status TEXT NOT NULL CHECK(status IN ('held','released','stale_recovered')),
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  lease_expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX resource_locks_active_key ON resource_locks(lock_key) WHERE status='held';
CREATE INDEX resource_locks_run_idx ON resource_locks(run_id, status);

-- mutation_journal: before-state for mutations to EXISTING/shared
-- resources (section 27) — exact-ID deletion (resource_ownership) doesn't
-- cover renaming a Custom Field back after a test changes it.
CREATE TABLE mutation_journal(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_version TEXT,
  before_state TEXT NOT NULL CHECK(json_valid(before_state)),
  primitive_id TEXT NOT NULL,
  restoration_strategy TEXT NOT NULL,
  restoration_status TEXT NOT NULL CHECK(restoration_status IN ('pending','restored','conflict','failed','skipped')) DEFAULT 'pending',
  restoration_note TEXT,
  restored_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX mutation_journal_run_idx ON mutation_journal(run_id, restoration_status);

-- Surfaced separately from the test result itself (section 28: "Do not
-- change the product-test result merely because cleanup failed. Surface
-- both.") — no CHECK constraint, matching migration 005's precedent for
-- ALTER TABLE ADD COLUMN; validated in application code instead.
ALTER TABLE runs ADD COLUMN cleanup_status TEXT;
