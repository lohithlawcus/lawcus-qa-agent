import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openResourceOwnership } from "../core/resource-ownership.mjs";
import { openResourceLocks } from "../core/resource-locks.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { createCleanupRunner } from "../core/cleanup.mjs";

function withRunner(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-cleanup-"));
  try {
    const { db, audit } = openStore(dir);
    const resourceOwnership = openResourceOwnership(db, audit);
    const resourceLocks = openResourceLocks(db, audit);
    const mutationJournal = openMutationJournal(db, audit);
    const cleanup = createCleanupRunner({ resourceOwnership, mutationJournal, resourceLocks });
    return fn({ db, resourceOwnership, resourceLocks, mutationJournal, cleanup });
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

test("with nothing owned and nothing journaled, cleanup is a real no-op that passes", () => {
  return withRunner(async ({ db, cleanup }) => {
    const runId = seedRun(db);
    const result = await cleanup.runCleanup({ runId });
    assert.equal(result.overall, "passed");
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.failed, []);
  });
});

test("a registered handler that succeeds marks the resource cleaned and passes overall", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "c-1", createdByPrimitive: "contacts.create",
    });
    const calls = [];
    const result = await cleanup.runCleanup({
      runId,
      deleteHandlers: { contact: async (r) => { calls.push(r.resource_id); } },
    });
    assert.equal(result.overall, "passed");
    assert.deepEqual(calls, ["c-1"]);
    assert.equal(resourceOwnership.forRun(runId)[0].cleanup_status, "cleaned");
  });
});

test("a handler reporting alreadyMissing records already_missing, not a failure", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "c-1", createdByPrimitive: "contacts.create",
    });
    const result = await cleanup.runCleanup({
      runId,
      deleteHandlers: { contact: async () => ({ alreadyMissing: true, note: "404 on delete." }) },
    });
    assert.equal(result.overall, "passed");
    assert.equal(resourceOwnership.forRun(runId)[0].cleanup_status, "already_missing");
  });
});

test("a handler that throws marks the resource failed and the overall result needs_review", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "c-1", createdByPrimitive: "contacts.create",
    });
    const result = await cleanup.runCleanup({
      runId,
      deleteHandlers: { contact: async () => { throw new Error("API refused the delete."); } },
    });
    assert.equal(result.overall, "needs_review");
    assert.equal(resourceOwnership.forRun(runId)[0].cleanup_status, "failed");
  });
});

test("an owned resource with no registered handler is skipped, not silently ignored — overall needs_review", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "lead", resourceId: "l-1", createdByPrimitive: "leads.create",
    });
    const result = await cleanup.runCleanup({ runId });
    assert.equal(result.overall, "needs_review");
    assert.equal(resourceOwnership.forRun(runId)[0].cleanup_status, "skipped");
  });
});

test("resources are cleaned in reverse dependency order: child before parent", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    const parent = resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "parent-1", createdByPrimitive: "contacts.create",
    });
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "note", resourceId: "note-1", parentResourceId: parent.id, createdByPrimitive: "notes.create",
    });
    const order = [];
    await cleanup.runCleanup({
      runId,
      deleteHandlers: {
        contact: async (r) => { order.push(r.resource_id); },
        note: async (r) => { order.push(r.resource_id); },
      },
    });
    assert.deepEqual(order, ["note-1", "parent-1"]);
  });
});

test("cleanup_policy='manual' resources are never touched, and are reported as leftovers — cleanup is NOT 'passed' while they sit in staging", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "manual-1", createdByPrimitive: "contacts.create", cleanupPolicy: "manual",
    });
    const calls = [];
    const result = await cleanup.runCleanup({ runId, deleteHandlers: { contact: async (r) => { calls.push(r.resource_id); } } });
    assert.deepEqual(calls, [], "a manual record must never be handed to a delete handler");
    assert.equal(result.overall, "needs_review");
    assert.deepEqual(result.leftovers.map((r) => r.resource_id), ["manual-1"]);
    assert.equal(resourceOwnership.forRun(runId)[0].cleanup_status, "pending");
  });
});

test("cleanup_policy='retain' resources are never touched and are not leftovers (someone chose to keep them)", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "keep-1", createdByPrimitive: "contacts.create", cleanupPolicy: "retain",
    });
    const calls = [];
    const result = await cleanup.runCleanup({ runId, deleteHandlers: { contact: async (r) => { calls.push(r.resource_id); } } });
    assert.deepEqual(calls, []);
    assert.equal(result.overall, "passed");
    assert.deepEqual(result.leftovers, []);
  });
});

test("a successful restoration handler is applied and recorded", () => {
  return withRunner(async ({ db, mutationJournal, cleanup }) => {
    const runId = seedRun(db);
    mutationJournal.recordBeforeState({
      runId, environmentId: "fixture", resourceType: "custom_field", resourceId: "cf-1",
      beforeState: { label: "Case Type" }, primitiveId: "custom_fields.rename", restorationStrategy: "rename back",
    });
    const calls = [];
    const result = await cleanup.runCleanup({
      runId,
      restoreHandlers: { custom_field: async (entry) => { calls.push(entry.before_state.label); } },
    });
    assert.equal(result.overall, "passed");
    assert.deepEqual(calls, ["Case Type"]);
    assert.equal(mutationJournal.forRun(runId)[0].restoration_status, "restored");
  });
});

test("cleanup never changes the run's own test result — it only produces a separate outcome the caller stores", () => {
  return withRunner(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    db.prepare("UPDATE runs SET status='passed' WHERE id=?").run(runId);
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "c-1", createdByPrimitive: "contacts.create",
    });
    const result = await cleanup.runCleanup({
      runId,
      deleteHandlers: { contact: async () => { throw new Error("boom"); } },
    });
    assert.equal(result.overall, "needs_review");
    assert.equal(db.prepare("SELECT status FROM runs WHERE id=?").get(runId).status, "passed");
  });
});

test("runCleanup releases every lock this run holds, even when cleanup itself has failures", () => {
  return withRunner(async ({ db, resourceOwnership, resourceLocks, cleanup }) => {
    const runId = seedRun(db);
    resourceLocks.acquire({ lockKey: "tenant:qa:custom-fields:contact", runId });
    resourceOwnership.recordCreated({
      runId, environmentId: "fixture", resourceType: "contact", resourceId: "c-1", createdByPrimitive: "contacts.create",
    });
    await cleanup.runCleanup({ runId, deleteHandlers: { contact: async () => { throw new Error("boom"); } } });
    assert.equal(resourceLocks.isHeld("tenant:qa:custom-fields:contact"), false);
  });
});
