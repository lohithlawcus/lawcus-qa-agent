-- Truthful run accounting.
--
-- runs.status keeps its legacy CHECK (running/passed/failed/interrupted):
-- SQLite cannot alter a CHECK, and rebuilding runs would mean rebuilding
-- every foreign key and the one_active_run partial index. A run that
-- verified nothing, or was cut short, is stored as 'interrupted' ("no
-- pass is claimed"); the columns below carry the real counts so nothing
-- has to be inferred from a status word.
ALTER TABLE runs ADD COLUMN outcome TEXT;
ALTER TABLE runs ADD COLUMN checks_planned INTEGER;
ALTER TABLE runs ADD COLUMN checks_executed INTEGER;
ALTER TABLE runs ADD COLUMN checks_passed INTEGER;
ALTER TABLE runs ADD COLUMN checks_failed INTEGER;
-- Git commit (plus "+dirty" if tracked files were modified at process
-- start) of the code that produced the run's results.
ALTER TABLE runs ADD COLUMN code_revision TEXT;

-- 'saved' | 'none_captured' | 'save_failed'. A failed evidence save is an
-- integrity problem, never a reason to change the check's own pass/fail.
ALTER TABLE scenario_results ADD COLUMN evidence_status TEXT;

-- Separate from review status: an approved case can be known-broken.
ALTER TABLE test_cases ADD COLUMN automation_readiness TEXT NOT NULL DEFAULT 'ready' CHECK(automation_readiness IN ('ready','quarantined'));
ALTER TABLE test_cases ADD COLUMN quarantine_reason TEXT;
