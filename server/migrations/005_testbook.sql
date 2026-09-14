-- V5 Step 5 — TestBook (section 10): Feature -> Suite -> Test Case ->
-- Versioned Test Definition -> Execution History.
--
-- Fields section 10 also lists (Knowledge references, Impact Graph
-- references, API contracts, API verification policy, persona/resource-lock
-- requirements) are intentionally NOT columns here: those subsystems don't
-- exist yet (Knowledge/Impact Graph is Step 9, API Contracts Step 10,
-- personas Step 12, resource locks Step 13). Adding empty placeholder
-- columns now would imply a capability that isn't real. They arrive as
-- additive migrations in the steps that actually implement them.
CREATE TABLE features(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE test_suites(
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(feature_id, name)
);
CREATE TABLE test_cases(
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES test_suites(id),
  -- The DSL definition's own `id` field (server/core/dsl.mjs) — the stable
  -- key a test case is known by outside the database.
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  layer TEXT NOT NULL CHECK(layer IN ('ui','api','both')),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
  risk TEXT NOT NULL CHECK(risk IN ('low','normal','high')),
  status TEXT NOT NULL CHECK(status IN ('approved','pending_review','deprecated')),
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Never rewritten (section 10: "Never rewrite historical TestBook
-- versions"). A changed DSL source for the same case inserts a new row.
CREATE TABLE test_definition_versions(
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id),
  version INTEGER NOT NULL,
  dsl_id TEXT NOT NULL,
  dsl_source TEXT NOT NULL,
  dsl_source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(test_case_id, version)
);
-- Links execution history to the TestBook without touching a single
-- existing row: both columns are nullable, so every scenario_results row
-- written before the TestBook existed stays exactly as it was (section 5.4:
-- "do not delete useful existing history"). testbook.mjs backfills
-- test_case_id for old rows it can confidently match by scenario name; it
-- never invents a test_definition_version_id for a run that predates
-- versioning.
ALTER TABLE scenario_results ADD COLUMN test_case_id TEXT REFERENCES test_cases(id);
ALTER TABLE scenario_results ADD COLUMN test_definition_version_id TEXT REFERENCES test_definition_versions(id);
