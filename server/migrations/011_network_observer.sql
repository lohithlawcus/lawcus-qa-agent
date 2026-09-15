-- V5 Step 11 / section 23 — Browser Network Contract Observer.
--
-- network_observations: one row per (scenario, declared expectation) —
-- e.g. "the valid_login scenario expects exactly_one POST to
-- lawcus.auth.login". Records what was actually observed against an
-- approved contract, never a raw request/response value (section 22's
-- sanitization discipline extended to captured browser traffic).
CREATE TABLE network_observations(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  scenario_result_id TEXT REFERENCES scenario_results(id),
  step_label TEXT NOT NULL,
  contract_id TEXT REFERENCES api_contracts(id),
  semantic_id TEXT NOT NULL,
  expected_cardinality TEXT NOT NULL CHECK(expected_cardinality IN ('exactly_one','one_or_more','zero','optional')),
  observed_count INTEGER NOT NULL,
  cardinality_ok INTEGER NOT NULL,
  contract_match INTEGER NOT NULL,
  mismatch_reason TEXT,
  request_summaries TEXT NOT NULL CHECK(json_valid(request_summaries)),
  response_summaries TEXT NOT NULL CHECK(json_valid(response_summaries)),
  created_at TEXT NOT NULL
);
CREATE INDEX network_observations_run_idx ON network_observations(run_id);

-- console_observations: captured browser console errors / uncaught page
-- errors (section "Browser": "console/page errors captured"). Observational
-- evidence only — nothing here fails a scenario by itself.
CREATE TABLE console_observations(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  scenario_result_id TEXT REFERENCES scenario_results(id),
  level TEXT NOT NULL CHECK(level IN ('console-error','page-error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX console_observations_run_idx ON console_observations(run_id);
