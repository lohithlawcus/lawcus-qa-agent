import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
export const now = () => new Date().toISOString();
export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const db = new DatabaseSync(join(directory, "qa.sqlite"));
  chmodSync(join(directory, "qa.sqlite"), 0o600);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=1").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        readFileSync(
          new URL("../migrations/001_initial.sql", import.meta.url),
          "utf8",
        ),
      );
      db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        readFileSync(
          new URL("../migrations/002_idempotency.sql", import.meta.url),
          "utf8",
        ),
      );
      db.prepare("INSERT INTO schema_migrations VALUES(2,?)").run(now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  db.prepare("INSERT OR IGNORE INTO environments VALUES(?,?,?,?,?)").run(
    "fixture",
    "Local test application",
    "http://127.0.0.1:4320",
    "fixture",
    1,
  );
  db.prepare("INSERT OR IGNORE INTO environments VALUES(?,?,?,?,?)").run(
    "lawcus",
    "Lawcus · verification needed",
    "https://lohith.fiveriverz.com",
    "unverified",
    0,
  );
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/003_environment_confirmation.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(3,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/004_proposals.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(4,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/005_testbook.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(5,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=6").get()) {
    // This migration rebuilds `runs` (SQLite can't ALTER a CHECK
    // constraint in place) while other tables still hold rows referencing
    // it. PRAGMA foreign_keys is a documented no-op inside a pending
    // transaction, so it must be toggled here, outside BEGIN/COMMIT.
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/006_execution_manifest.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(6,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("PRAGMA foreign_keys=ON");
    const inconsistent = db.prepare("PRAGMA foreign_key_check").all();
    if (inconsistent.length)
      throw new Error(
        `Migration 6 left inconsistent foreign keys: ${JSON.stringify(inconsistent)}`,
      );
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/007_intent_router.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(7,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/008_model_usage.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(8,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/009_knowledge_graph.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(9,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=10").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/010_api_contracts.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(10,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=11").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/011_network_observer.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=12").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/012_personas.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(12,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=13").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/013_resource_locks.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(13,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=14").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/014_authoring_sessions.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(14,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=15").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/015_knowledge_structured_fields.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(15,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=16").get()) {
    // This migration rebuilds `proposals` (SQLite can't ALTER a CHECK
    // constraint in place), same pattern as migration 006's `runs` rebuild.
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/016_impacted_testing_origin.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(16,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("PRAGMA foreign_keys=ON");
    const inconsistentProposals = db.prepare("PRAGMA foreign_key_check").all();
    if (inconsistentProposals.length)
      throw new Error(`Migration 16 left inconsistent foreign keys: ${JSON.stringify(inconsistentProposals)}`);
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=17").get()) {
    // Same rebuild pattern as migration 16, widening generated_by again.
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/017_mcp_origin.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(17,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("PRAGMA foreign_keys=ON");
    const inconsistentProposals17 = db.prepare("PRAGMA foreign_key_check").all();
    if (inconsistentProposals17.length)
      throw new Error(`Migration 17 left inconsistent foreign keys: ${JSON.stringify(inconsistentProposals17)}`);
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=18").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(new URL("../migrations/018_ai_gate.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES(18,?)").run(now());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  // AI is enabled by default — the Gate's whole job is auditing/permitting
  // real usage, not silently turning it off. INSERT OR IGNORE means this
  // never overwrites an operator's own choice on a later startup.
  db.prepare("INSERT OR IGNORE INTO ai_gate_settings(id,ai_enabled,updated_at) VALUES(1,1,?)").run(now());
  const stale = db.prepare("SELECT id FROM runs WHERE status='running'").all();
  db.prepare(
    "UPDATE runs SET status='interrupted',finished_at=?,summary='The runner stopped before this run completed. Review the partial results before running again.' WHERE status='running'",
  ).run(now());
  const audit = (action, entityId, details = {}) =>
    db
      .prepare(
        "INSERT INTO audit_events(id,actor,action,entity_id,details,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        "local-operator",
        action,
        entityId,
        JSON.stringify(details),
        now(),
      );
  for (const row of stale) audit("run.interrupted", row.id);
  return { db, audit };
}
