-- V5 Step 18 — widens proposals.generated_by's CHECK constraint to admit
-- "mcp_tool" as a real, distinct non-human origin (section 41: MCP tools
-- may create_test_proposal / create_failure_analysis_proposal, but "MCP
-- is an interface to Core. It is not the source of truth and not the
-- security boundary" — a proposal filed via MCP goes through the exact
-- same pending_review -> human-approval gate as every other origin).
--
-- SQLite can't ALTER a CHECK constraint in place; rebuild the table and
-- copy every row across unchanged, same pattern as migrations 006 and 016.
-- foreign_keys is toggled OFF around this migration from store.mjs,
-- outside this transaction.
CREATE TABLE proposals_new(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN (
    'NEW_TEST','TEST_CHANGE','NEW_PRIMITIVE','PRIMITIVE_CHANGE','LOCATOR_REPAIR',
    'TESTABILITY_HOOK_REQUEST','KNOWLEDGE_CHANGE','DEPENDENCY_CHANGE',
    'API_CONTRACT_CHANGE','ENVIRONMENT_CHANGE','NETWORK_AUTHORITY_CHANGE','PERMISSION_CHANGE')),
  status TEXT NOT NULL CHECK(status IN (
    'pending_review','approved','rejected','superseded','expired')),
  summary TEXT NOT NULL,
  trigger TEXT NOT NULL,
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
  generated_by TEXT NOT NULL CHECK(generated_by IN (
    'runner','ai_planner','recorder','network_observer','operator','impacted_testing','mcp_tool')),
  run_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
);
INSERT INTO proposals_new SELECT
  id,type,status,summary,trigger,subject_kind,subject_id,base_version,current_value,proposed_value,
  evidence,confidence,risk,impacted_features,impacted_tests,impacted_api_contracts,required_approver_role,
  generated_by,run_id,created_at,expires_at,decided_at,decided_by,decision_note
  FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;
CREATE INDEX proposals_status_idx ON proposals(status, created_at);
CREATE INDEX proposals_subject_idx ON proposals(subject_kind, subject_id, status);
