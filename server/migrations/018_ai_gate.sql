-- V5 Upgrade Phase U1 — AI Gate / Intelligence Policy Engine.
--
-- ai_gate_settings: a singleton row (id is always 1) holding the operator
-- kill switch. The V5 Upgrade doc calls this "AI_ENABLED=false" as an
-- environment-variable-style concept; implemented here as a real,
-- persisted, UI-toggleable setting instead of an env var, since every
-- other operator-facing control in this project (environments, personas,
-- network authority, ...) is DB-backed and audit-logged, not
-- process-restart-dependent.
CREATE TABLE ai_gate_settings(
  id INTEGER PRIMARY KEY CHECK(id = 1),
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- ai_gate_requests: the full request-level ledger section 3.3 of the V5
-- Upgrade doc asks for — every request that ever reached the Gate,
-- whether it was allowed through to a real provider call or refused
-- (AI disabled). This is a superset of model_usage (Step 8, migration
-- 008): model_usage only ever records a call that actually consumed
-- tokens; a row here exists for every Gate decision, allowed or not, so
-- "AI usage cannot silently grow unnoticed" (the doc's own acceptance
-- criterion) is checkable by counting rows here, not just tokens spent.
CREATE TABLE ai_gate_requests(
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  category TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  requester TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  runbook_id TEXT REFERENCES runbooks(id),
  model_usage_id TEXT REFERENCES model_usage(id),
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_gate_requests_created_idx ON ai_gate_requests(created_at);
CREATE INDEX ai_gate_requests_task_idx ON ai_gate_requests(task, created_at);
