-- V5 Step 6 — Immutable Run Execution Manifest (section 15, mandatory) +
-- richer execution statuses (section 16).
--
-- run_execution_manifests is write-once by convention: the application
-- code only ever INSERTs a row here, at run creation, before execution
-- begins, and never UPDATEs one. That is what "frozen" means in practice —
-- the run that already started keeps using its own in-memory primitive/DSL
-- state regardless of what this row says; the row exists so later
-- inspection/audit can see exactly what versions actually applied,
-- reproducibly, without re-deriving them from what's current now.
--
-- Fields section 15 also lists (network authority version, persona,
-- Knowledge versions, API contract versions, API environment-adapter
-- version, Impact Graph version, test-data policy version, app/release
-- metadata) are NOT captured yet — those subsystems don't exist (Steps 9,
-- 10, 12) or aren't versioned yet. The manifest JSON only records what this
-- codebase actually has right now: environment, requester, trigger source,
-- runner git revision, and the exact test-case/DSL-version/primitive-version
-- set the run's plan resolved to. Later steps extend the JSON shape rather
-- than widen this table — it's schema-flexible by design (one JSON blob).
CREATE TABLE run_execution_manifests(
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  manifest TEXT NOT NULL CHECK(json_valid(manifest)),
  created_at TEXT NOT NULL
);

-- SQLite can't ALTER a CHECK constraint in place; rebuild the table with the
-- widened status list (section 16) and copy every row across unchanged.
-- foreign_keys is toggled OFF around this migration from store.mjs, outside
-- this transaction — PRAGMA foreign_keys is a documented no-op inside a
-- pending transaction, so setting it here would do nothing and DROP TABLE
-- would fail closed against the real scenario_results/artifacts/
-- clarifications/run_execution_manifests rows that reference runs(id).
CREATE TABLE runs_new(
  id TEXT PRIMARY KEY,
  runbook_id TEXT NOT NULL REFERENCES runbooks(id),
  status TEXT NOT NULL CHECK(status IN (
    'running','passed','failed','blocked','needs_review','cancelled','interrupted'
  )),
  replay INTEGER NOT NULL,
  path_id TEXT REFERENCES execution_paths(id),
  model_calls INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  request_key TEXT
);
INSERT INTO runs_new(id,runbook_id,status,replay,path_id,model_calls,started_at,finished_at,summary,request_key)
  SELECT id,runbook_id,status,replay,path_id,model_calls,started_at,finished_at,summary,request_key FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE UNIQUE INDEX one_active_run ON runs(status) WHERE status = 'running';
CREATE UNIQUE INDEX run_request_key ON runs(request_key) WHERE request_key IS NOT NULL;
