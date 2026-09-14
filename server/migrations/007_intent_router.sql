-- V5 Step 7 / section 32 — persist every intent resolution attempt: the
-- original prompt, its normalized form, whether it resolved locally, the
-- confidence, and which TestBook feature/suite/cases it matched (if any).
-- A row is written whenever a plan is actually created from operator-typed
-- intent (not for the "standard" fixed-checks path, which never attempts
-- interpretation at all — there's nothing to resolve).
CREATE TABLE intent_resolutions(
  id TEXT PRIMARY KEY,
  runbook_id TEXT NOT NULL REFERENCES runbooks(id),
  original_prompt TEXT NOT NULL,
  normalized_intent TEXT NOT NULL,
  resolved_locally INTEGER NOT NULL,
  confidence REAL NOT NULL,
  matched_feature_id TEXT REFERENCES features(id),
  matched_suite_id TEXT REFERENCES test_suites(id),
  matched_case_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(matched_case_ids)),
  created_at TEXT NOT NULL
);
CREATE INDEX intent_resolutions_runbook_idx ON intent_resolutions(runbook_id);
