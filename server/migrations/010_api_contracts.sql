-- V5 Step 10 / sections 19-22 — API Contract Registry, Environment Adapter,
-- Network Authority. Same versioned-and-approved discipline as Knowledge
-- (Step 9): nothing here is ever rewritten in place, and nothing here
-- self-approves (section 14 applied to API execution too).

-- api_contracts: one versioned, approved-or-not record per semantic API
-- operation (section 19). provenance distinguishes official Lawcus API
-- documentation ('DOCUMENTED') from behavior this project has itself
-- observed against real staging ('OBSERVED_API') — an OBSERVED_API contract
-- must not silently become an approved one just because it was captured
-- from a real endpoint.
CREATE TABLE api_contracts(
  id TEXT PRIMARY KEY,
  semantic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  feature_id TEXT NOT NULL REFERENCES features(id),
  operation TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('GET','POST','PUT','PATCH','DELETE','HEAD')),
  path_template TEXT NOT NULL,
  request_schema TEXT CHECK(request_schema IS NULL OR json_valid(request_schema)),
  response_schema TEXT NOT NULL CHECK(json_valid(response_schema)),
  expected_statuses TEXT NOT NULL CHECK(json_valid(expected_statuses)),
  error_contract TEXT CHECK(error_contract IS NULL OR json_valid(error_contract)),
  read_write TEXT NOT NULL CHECK(read_write IN ('read','write')),
  verification_requirements TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('DOCUMENTED','OBSERVED_API')),
  doc_source_id TEXT REFERENCES knowledge_sources(id),
  doc_version TEXT,
  doc_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected','superseded')),
  supersedes TEXT REFERENCES api_contracts(id),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  UNIQUE(semantic_id, version)
);
CREATE INDEX api_contracts_feature_idx ON api_contracts(feature_id, status);
CREATE INDEX api_contracts_semantic_idx ON api_contracts(semantic_id);

-- environment_adapters: the only place a host/origin mapping for an
-- environment lives (section 20). Functional API contracts never embed a
-- host — the Safe API Executor resolves the current approved adapter for
-- the environment at call time.
CREATE TABLE environment_adapters(
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  version INTEGER NOT NULL,
  api_origin TEXT NOT NULL,
  app_origin TEXT NOT NULL,
  assets_origin TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected','superseded')),
  supersedes TEXT REFERENCES environment_adapters(id),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  UNIQUE(environment_id, version)
);
CREATE INDEX environment_adapters_env_idx ON environment_adapters(environment_id, status);

-- network_authorities: approved host/method/redirect policy for an
-- environment (section 21), separate from what a contract says an endpoint
-- should do. An approved API contract does not, by itself, grant permission
-- to contact anything.
CREATE TABLE network_authorities(
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  version INTEGER NOT NULL,
  allowed_hosts TEXT NOT NULL CHECK(json_valid(allowed_hosts)),
  allowed_methods TEXT NOT NULL CHECK(json_valid(allowed_methods)),
  allow_redirects INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected','superseded')),
  supersedes TEXT REFERENCES network_authorities(id),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  UNIQUE(environment_id, version)
);
CREATE INDEX network_authorities_env_idx ON network_authorities(environment_id, status);

-- api_calls: sanitized evidence for every real Safe API Executor call
-- (section 22 — "request/response sanitization"). Never stores a raw
-- Authorization value or credential; request_summary/response_summary hold
-- only what execute() decided was safe to keep. contract_match records
-- whether the response actually conformed to the resolved contract, so a
-- drifted response is visible without being silently healed.
CREATE TABLE api_calls(
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES api_contracts(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  run_id TEXT REFERENCES runs(id),
  request_summary TEXT NOT NULL CHECK(json_valid(request_summary)),
  response_status INTEGER,
  response_summary TEXT CHECK(response_summary IS NULL OR json_valid(response_summary)),
  contract_match INTEGER NOT NULL,
  mismatch_reason TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX api_calls_contract_idx ON api_calls(contract_id, created_at);
