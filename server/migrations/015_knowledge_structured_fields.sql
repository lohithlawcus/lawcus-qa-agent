-- V5 — Knowledge Base rework to match the operator's supplied
-- LAWCUS_QA_KNOWLEDGE_BASE_GUIDE.md exactly, not just the master spec's
-- sections 8/9 that Step 9 was originally built from. Additive only --
-- every existing knowledge_items/behavior_graph_edges row and column
-- stays; nothing here is dropped or renamed.
--
-- The guide's Business Rule template (section 6) needs four things Step
-- 9's schema didn't have a place for: applies_to (which entity types a
-- rule concerns), a structured expected_behavior broken out by
-- existing/new record state (section 19 -- "do not assume new-record
-- behavior proves existing-record behavior"), preconditions, and
-- effective_from/effective_until/release (section 34). And it wants a
-- rule linked directly to the specific API contracts and test cases that
-- back it (section 6's api_contracts:/related_tests: lists), which is a
-- finer grain than the existing feature-to-feature behavior_graph_edges.
ALTER TABLE knowledge_items ADD COLUMN applies_to TEXT CHECK(applies_to IS NULL OR json_valid(applies_to));
ALTER TABLE knowledge_items ADD COLUMN preconditions TEXT CHECK(preconditions IS NULL OR json_valid(preconditions));
ALTER TABLE knowledge_items ADD COLUMN expected_behavior TEXT CHECK(expected_behavior IS NULL OR json_valid(expected_behavior));
ALTER TABLE knowledge_items ADD COLUMN effective_from TEXT;
ALTER TABLE knowledge_items ADD COLUMN effective_until TEXT;
ALTER TABLE knowledge_items ADD COLUMN release TEXT;

-- Links a Knowledge item to the API Contract Registry (Step 10) it relies
-- on, by semantic_id rather than a specific versioned row -- an approved
-- contract can gain a new version without this link going stale. Not a
-- hard FK: api_contracts.semantic_id is only unique per (semantic_id,
-- version), so there is no single row to reference; the seed author is
-- responsible for citing a real semantic_id (same discipline as every
-- other "do not invent" rule in this project), same as api-client.mjs's
-- own semantic_id lookups are not FK-enforced either.
CREATE TABLE knowledge_item_api_contracts(
  id TEXT PRIMARY KEY,
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
  api_contract_semantic_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(knowledge_item_id, api_contract_semantic_id)
);
CREATE INDEX knowledge_item_api_contracts_item_idx ON knowledge_item_api_contracts(knowledge_item_id);

-- Links a Knowledge item to the TestBook (Step 5) case that proves it.
-- test_cases.external_id is genuinely unique (migration 005), so this one
-- is a real FK.
CREATE TABLE knowledge_item_tests(
  id TEXT PRIMARY KEY,
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
  test_case_external_id TEXT NOT NULL REFERENCES test_cases(external_id),
  created_at TEXT NOT NULL,
  UNIQUE(knowledge_item_id, test_case_external_id)
);
CREATE INDEX knowledge_item_tests_item_idx ON knowledge_item_tests(knowledge_item_id);
