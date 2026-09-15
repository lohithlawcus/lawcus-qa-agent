-- V5 Step 14 / section 29 — Recorder / Teaching Mode Foundation.
--
-- authoring_sessions: the audit trail section 29.9 requires (session ID,
-- operator, environment, persona, feature, start/end, generated/discarded
-- proposals). "Authoring artifacts and trusted execution evidence are
-- separate concepts" (29.9, last line) — this is why authoring sessions
-- get their own tables here rather than reusing runs/scenario_results/
-- network_observations from earlier steps.
CREATE TABLE authoring_sessions(
  id TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  persona_id TEXT REFERENCES personas(id),
  feature_name TEXT NOT NULL,
  workflow_description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','completed','discarded','failed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  proposal_ids TEXT CHECK(proposal_ids IS NULL OR json_valid(proposal_ids)),
  discard_reason TEXT
);
CREATE INDEX authoring_sessions_status_idx ON authoring_sessions(status);

-- authoring_candidate_actions: the normalized capture of what the operator
-- actually did (section 29's "Capture candidate: actions, locators, UI
-- observations"). This table IS the AUTHORING_ARTIFACT (section 29.2) —
-- never eval'd, never auto-executed, never auto-saved as an approved
-- TestBook case. redacted=1 rows never had their real value stored at
-- all (value_literal stays NULL); section 29.3.
CREATE TABLE authoring_candidate_actions(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES authoring_sessions(id),
  sequence INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('click','input','change','submit','navigate')),
  locator_candidate TEXT NOT NULL CHECK(json_valid(locator_candidate)),
  locator_quality TEXT NOT NULL CHECK(locator_quality IN ('stable','unstable')),
  redacted INTEGER NOT NULL DEFAULT 0,
  value_summary TEXT,
  value_literal TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX authoring_candidate_actions_session_idx ON authoring_candidate_actions(session_id, sequence);

-- authoring_network_observations: section 29.7 — "Recording may
-- simultaneously observe relevant requests/responses." Sanitized the same
-- way as Step 11's network_observations (keys/shape only), but a
-- separate table on purpose (29.9's last line again) — this traffic was
-- observed during unstructured manual authoring, not during a trusted,
-- versioned test run, and must never be confused with the latter.
CREATE TABLE authoring_network_observations(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES authoring_sessions(id),
  method TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  request_summary TEXT NOT NULL CHECK(json_valid(request_summary)),
  response_summary TEXT CHECK(response_summary IS NULL OR json_valid(response_summary)),
  observed_at TEXT NOT NULL
);
CREATE INDEX authoring_network_observations_session_idx ON authoring_network_observations(session_id);
