-- A sweep is a READ-ONLY look at what is in a staging tenant that this tool
-- may have left there. It reads the tenant's own list pages and keeps only the
-- records whose names match this tool's QA naming; nothing else is copied. A
-- finding is a candidate (a name pattern is not proof), classified against the
-- local ownership records, and a person decides what it is.
CREATE TABLE staging_sweeps(
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed')),
  cutoff TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  scanned TEXT CHECK(scanned IS NULL OR json_valid(scanned)),
  matched_count INTEGER NOT NULL DEFAULT 0,
  untracked_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  failure_class TEXT CHECK(failure_class IS NULL OR failure_class IN ('functional','infrastructure','automation','integrity','unclassified')),
  reason_code TEXT,
  code_revision TEXT,
  requested_by TEXT NOT NULL
);
CREATE TABLE staging_sweep_records(
  id TEXT PRIMARY KEY,
  sweep_id TEXT NOT NULL REFERENCES staging_sweeps(id),
  kind TEXT NOT NULL CHECK(kind IN ('contact','matter','lead')),
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at_remote TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('untracked','tracked','protected')),
  ownership_run_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status IN ('unreviewed','confirmed_qa','not_qa','left_in_place')),
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  UNIQUE(sweep_id, kind, remote_id)
);
CREATE INDEX staging_sweep_records_remote ON staging_sweep_records(kind, remote_id);
