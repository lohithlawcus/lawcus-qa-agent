-- Safety controls for external AI planning. Existing ai_gate_settings rows are
-- untouched: in particular, a disabled operator switch stays disabled.
CREATE TABLE ai_safety_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  circuit_open INTEGER NOT NULL DEFAULT 0 CHECK (circuit_open IN (0, 1)),
  reason_code TEXT,
  opened_at TEXT,
  reset_at TEXT,
  reset_by TEXT
);
INSERT INTO ai_safety_state(id) VALUES (1);

-- No prompt, model response, credential, DOM, or hidden reasoning is stored.
-- The chain detects accidental or partial changes to this local database;
-- someone who can rewrite SQLite can also recompute the unkeyed hashes.
CREATE TABLE ai_decision_ledger (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  gate_request_id TEXT NOT NULL REFERENCES ai_gate_requests(id),
  phase TEXT NOT NULL CHECK (phase IN ('refused', 'started', 'completed', 'failed')),
  task TEXT NOT NULL,
  requester TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  policy_version TEXT NOT NULL,
  input_salt TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  error_code TEXT,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_decision_ledger_request_idx ON ai_decision_ledger(gate_request_id);
CREATE INDEX ai_decision_ledger_phase_idx ON ai_decision_ledger(phase, created_at);

CREATE TABLE ai_safety_incidents (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  reason_code TEXT NOT NULL,
  gate_request_id TEXT REFERENCES ai_gate_requests(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT
);
CREATE INDEX ai_safety_incidents_status_idx ON ai_safety_incidents(status, opened_at);

CREATE TABLE ai_residual_risks (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  mitigation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'mitigated')),
  review_owner TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ai_residual_risks VALUES
  ('local-db-edit', 'A local actor with SQLite write access can rewrite the ledger and its hashes.', 'Keep OS file permissions restrictive and independently back up audit evidence.', 'open', 'operator', datetime('now')),
  ('stale-product-rules', 'Approved Knowledge and API contracts can lag the deployed Lawcus behavior.', 'Require human review of changed rules and show gaps before execution.', 'open', 'QA owner', datetime('now')),
  ('staging-leftovers', 'Created staging records are retained while deletion authority remains undecided.', 'Track exact ownership and review the read-only staging sweep.', 'open', 'operator', datetime('now'));
