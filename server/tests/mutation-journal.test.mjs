import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openMutationJournal, MutationJournalError } from "../core/mutation-journal.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-mutation-journal-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openMutationJournal(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
    runbookId, 1, "fixture", "t", "intent", "built-in", JSON.stringify({ scenarios: ["valid_login"] }), new Date().toISOString(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(
    runId, runbookId, "passed", 0, new Date().toISOString(),
  );
  return runId;
}

const BASE = {
  environmentId: "fixture",
  resourceType: "custom_field",
  resourceId: "cf-42",
  primitiveId: "custom_fields.rename",
  restorationStrategy: "rename back to before-state.label",
};

test("recordBeforeState stores the exact before-state and returns it back unparsed-round-trip", () => {
  withStore((journal, db) => {
    const runId = seedRun(db);
    const entry = journal.recordBeforeState({ ...BASE, runId, beforeState: { label: "Case Type" } });
    assert.equal(entry.restoration_status, "pending");
    assert.deepEqual(entry.beforeState, { label: "Case Type" });
    assert.deepEqual(journal.forRun(runId)[0].before_state, { label: "Case Type" });
  });
});

test("recordRestoration requires a pending entry and cannot be applied twice", () => {
  withStore((journal, db) => {
    const runId = seedRun(db);
    const entry = journal.recordBeforeState({ ...BASE, runId, beforeState: { label: "Case Type" } });
    const restored = journal.recordRestoration(entry.id, { status: "restored" });
    assert.equal(restored.restoration_status, "restored");
    assert.throws(
      () => journal.recordRestoration(entry.id, { status: "restored" }),
      (e) => e instanceof MutationJournalError && e.code === "not_pending",
    );
  });
});

test("recordRestoration can record a failure without losing the before-state", () => {
  withStore((journal, db) => {
    const runId = seedRun(db);
    const entry = journal.recordBeforeState({ ...BASE, runId, beforeState: { label: "Case Type" } });
    const failed = journal.recordRestoration(entry.id, { status: "failed", note: "Concurrent edit detected (409)." });
    assert.equal(failed.restoration_status, "failed");
    assert.equal(failed.restoration_note, "Concurrent edit detected (409).");
  });
});

test("pendingRestorationsForRun returns only pending entries, most recent first (LIFO)", () => {
  withStore((journal, db) => {
    const runId = seedRun(db);
    const first = journal.recordBeforeState({ ...BASE, runId, resourceId: "cf-1", beforeState: { label: "A" } });
    const second = journal.recordBeforeState({ ...BASE, runId, resourceId: "cf-2", beforeState: { label: "B" } });
    journal.recordRestoration(first.id, { status: "restored" });
    const pending = journal.pendingRestorationsForRun(runId);
    assert.deepEqual(pending.map((e) => e.id), [second.id]);
  });
});

test("forRun returns entries regardless of restoration status, with before_state parsed", () => {
  withStore((journal, db) => {
    const runId = seedRun(db);
    const entry = journal.recordBeforeState({ ...BASE, runId, beforeState: { label: "Case Type" } });
    journal.recordRestoration(entry.id, { status: "restored" });
    const all = journal.forRun(runId);
    assert.equal(all.length, 1);
    assert.equal(all[0].restoration_status, "restored");
    assert.deepEqual(all[0].before_state, { label: "Case Type" });
  });
});
