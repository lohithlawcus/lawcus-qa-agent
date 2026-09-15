import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openResourceOwnership, ResourceOwnershipError, reverseDependencyOrder } from "../core/resource-ownership.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-resource-ownership-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openResourceOwnership(db, audit), db);
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
  resourceType: "contact",
  resourceId: "srv-1",
  createdByPrimitive: "contacts.create",
};

test("recordCreated stores a pending resource, owned by an exact run", () => {
  withStore((ownership, db) => {
    const runId = seedRun(db);
    const row = ownership.recordCreated({ ...BASE, runId });
    assert.equal(row.cleanup_status, "pending");
    assert.equal(row.run_id, runId);
    assert.equal(ownership.forRun(runId).length, 1);
  });
});

test("two rows cannot claim the same (environment, type, resource id) — exact-ID ownership is exclusive", () => {
  withStore((ownership, db) => {
    const runA = seedRun(db);
    const runB = seedRun(db);
    ownership.recordCreated({ ...BASE, runId: runA });
    assert.throws(
      () => ownership.recordCreated({ ...BASE, runId: runB }),
      (e) => e instanceof ResourceOwnershipError && e.code === "already_owned",
    );
  });
});

test("recordCreated rejects an unknown cleanup policy", () => {
  withStore((ownership, db) => {
    const runId = seedRun(db);
    assert.throws(
      () => ownership.recordCreated({ ...BASE, runId, cleanupPolicy: "delete-immediately" }),
      (e) => e instanceof ResourceOwnershipError && e.code === "unknown_cleanup_policy",
    );
  });
});

test("pendingCleanupForRun only returns cleanup_policy='auto' resources still pending", () => {
  withStore((ownership, db) => {
    const runId = seedRun(db);
    const auto = ownership.recordCreated({ ...BASE, runId, resourceId: "auto-1", cleanupPolicy: "auto" });
    ownership.recordCreated({ ...BASE, runId, resourceId: "manual-1", cleanupPolicy: "manual" });
    ownership.recordCreated({ ...BASE, runId, resourceId: "retain-1", cleanupPolicy: "retain" });
    const already = ownership.recordCreated({ ...BASE, runId, resourceId: "auto-2", cleanupPolicy: "auto" });
    ownership.markCleanup(already.id, { status: "cleaned" });
    const pending = ownership.pendingCleanupForRun(runId);
    assert.deepEqual(pending.map((r) => r.id), [auto.id]);
  });
});

test("markCleanup records status, note and timestamp", () => {
  withStore((ownership, db) => {
    const runId = seedRun(db);
    const row = ownership.recordCreated({ ...BASE, runId });
    ownership.markCleanup(row.id, { status: "already_missing", note: "404 on delete — treated as success." });
    const updated = ownership.forRun(runId)[0];
    assert.equal(updated.cleanup_status, "already_missing");
    assert.equal(updated.cleanup_note, "404 on delete — treated as success.");
    assert.ok(updated.cleaned_at);
  });
});

test("reverseDependencyOrder places a child before its parent", () => {
  const parent = { id: "p", parent_resource_id: null };
  const child = { id: "c", parent_resource_id: "p" };
  const order = reverseDependencyOrder([parent, child]);
  assert.deepEqual(order.map((r) => r.id), ["c", "p"]);
});

test("reverseDependencyOrder handles a three-level chain: grandchild, then child, then grandparent", () => {
  const grandparent = { id: "gp", parent_resource_id: null };
  const parent = { id: "p", parent_resource_id: "gp" };
  const child = { id: "c", parent_resource_id: "p" };
  // Deliberately out of order on input — the algorithm must not depend on input order.
  const order = reverseDependencyOrder([parent, grandparent, child]);
  assert.deepEqual(order.map((r) => r.id), ["c", "p", "gp"]);
});

test("reverseDependencyOrder places a parent with two children after both, in some order", () => {
  const parent = { id: "p", parent_resource_id: null };
  const childA = { id: "a", parent_resource_id: "p" };
  const childB = { id: "b", parent_resource_id: "p" };
  const order = reverseDependencyOrder([parent, childA, childB]);
  assert.equal(order[order.length - 1].id, "p");
  assert.deepEqual(new Set(order.slice(0, 2).map((r) => r.id)), new Set(["a", "b"]));
});

test("reverseDependencyOrder leaves unrelated resources in a valid order without needing each other", () => {
  const a = { id: "a", parent_resource_id: null };
  const b = { id: "b", parent_resource_id: null };
  const order = reverseDependencyOrder([a, b]);
  assert.deepEqual(new Set(order.map((r) => r.id)), new Set(["a", "b"]));
});

test("reverseDependencyOrder ignores a parent_resource_id pointing outside the given set (already cleaned, or another run)", () => {
  const child = { id: "c", parent_resource_id: "not-in-this-set" };
  const order = reverseDependencyOrder([child]);
  assert.deepEqual(order.map((r) => r.id), ["c"]);
});
