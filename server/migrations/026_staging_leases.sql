-- One staging operation at a time per environment, enforced by the database itself.
-- A run, sweep, deletion or MCP suite takes the lease before it touches staging and
-- releases it only after its browser work and cleanup have finished. The partial unique
-- index makes a second 'active' lease for the same environment impossible, even if two
-- requests race. A lease still 'active' after a restart belongs to a process that no
-- longer exists, so it is marked 'abandoned' with an audit event (never silently reused).
CREATE TABLE staging_leases(
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  kind TEXT NOT NULL CHECK(kind IN ('run','impacted_run','suite_run','sweep','deletion')),
  status TEXT NOT NULL CHECK(status IN ('active','released','abandoned')),
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX staging_leases_one_active ON staging_leases(environment_id) WHERE status='active';

-- Every sign-in attempt is written before the browser starts, under the lease that
-- authorised it. Staging sign-in budgets count these rows, not run rows.
CREATE TABLE staging_sign_ins(
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES staging_leases(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  purpose TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX staging_sign_ins_env_time ON staging_sign_ins(environment_id, attempted_at);
