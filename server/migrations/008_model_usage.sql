-- V5 Step 8 / section 33.3 — "Track model: provider, model, purpose,
-- tokens/usage, cost if available, run/proposal relationship."
--
-- cost isn't included: no pricing table or $ conversion exists anywhere in
-- this codebase, and fabricating one would be an invented number, not a
-- tracked fact. run_id/proposal_id relationship columns aren't included
-- either — the only AI-consuming task that exists is plan creation, so the
-- only real relationship right now is to the resulting runbook. A run_id
-- or proposal_id column arrives, additively, the day an actual task uses
-- AI during run execution or proposal generation.
CREATE TABLE model_usage(
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  runbook_id TEXT REFERENCES runbooks(id),
  created_at TEXT NOT NULL
);
CREATE INDEX model_usage_runbook_idx ON model_usage(runbook_id);
