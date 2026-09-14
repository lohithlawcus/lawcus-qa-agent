-- V5 Step 2 — Proposal / Approval foundation (spec section 14).
-- Every field below is required by section 14 "Each proposal stores".
CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN (
    'NEW_TEST','TEST_CHANGE','NEW_PRIMITIVE','PRIMITIVE_CHANGE','LOCATOR_REPAIR',
    'TESTABILITY_HOOK_REQUEST','KNOWLEDGE_CHANGE','DEPENDENCY_CHANGE',
    'API_CONTRACT_CHANGE','ENVIRONMENT_CHANGE','NETWORK_AUTHORITY_CHANGE','PERMISSION_CHANGE')),
  status TEXT NOT NULL CHECK(status IN (
    'pending_review','approved','rejected','superseded','expired')),
  summary TEXT NOT NULL,
  trigger TEXT NOT NULL,
  -- Optimistic concurrency: the trusted version this proposal was computed against.
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  current_value TEXT,
  proposed_value TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  risk TEXT NOT NULL CHECK(risk IN ('low','medium','high')),
  impacted_features TEXT NOT NULL DEFAULT '[]',
  impacted_tests TEXT NOT NULL DEFAULT '[]',
  impacted_api_contracts TEXT NOT NULL DEFAULT '[]',
  required_approver_role TEXT NOT NULL,
  -- section 14: "AI cannot approve" / "browser content cannot approve".
  -- generated_by records origin; it is never an approver identity.
  generated_by TEXT NOT NULL CHECK(generated_by IN (
    'runner','ai_planner','recorder','network_observer','operator')),
  run_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS proposals_subject_idx ON proposals(subject_kind, subject_id, status);

-- The trusted, approved value for each subject. Nothing writes here except an
-- approval transaction. Step 1: the runner may no longer write to this table.
CREATE TABLE IF NOT EXISTS trusted_versions(
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_proposal TEXT,
  PRIMARY KEY(subject_kind, subject_id)
);
