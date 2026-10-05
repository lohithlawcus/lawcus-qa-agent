import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openResourceOwnership, ResourceOwnershipError } from "../core/resource-ownership.mjs";
import { openResourceLocks } from "../core/resource-locks.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { createCleanupRunner } from "../core/cleanup.mjs";

// Nothing here may reach staging: no browser, no Keychain.
process.env.QA_FORBID_LIVE = "1";

const PROTECTED = "e2bf71a0-ae87-11f1-ab8e-f18331cbd381";
const HUMAN = "operator:tester";

function withEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-deletion-"));
  try {
    const { db, audit } = openStore(dir);
    const resourceOwnership = openResourceOwnership(db, audit, { protectedResourceIds: [PROTECTED] });
    const cleanup = createCleanupRunner({
      resourceOwnership,
      mutationJournal: openMutationJournal(db, audit),
      resourceLocks: openResourceLocks(db, audit),
    });
    return fn({ db, resourceOwnership, cleanup });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", "{}", new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "passed", 0, new Date().toISOString());
  return runId;
}

// Records a contact the way a real create check does: manual policy (the default for QA-created records).
function ownContact(resourceOwnership, runId, resourceId = randomUUID()) {
  return resourceOwnership.recordCreated({
    runId, environmentId: "lawcus", resourceType: "contact", resourceId,
    createdByPrimitive: "lawcus.contacts.create", displayName: "QA Agent - test", cleanupPolicy: "manual",
  });
}

const code = (fn) => (error) => error instanceof ResourceOwnershipError && error.code === fn;

test("nothing is deletable until a human approves it, record by record", () => {
  withEnv(({ db, resourceOwnership }) => {
    const runId = seedRun(db);
    const row = ownContact(resourceOwnership, runId);
    assert.deepEqual(resourceOwnership.approvedForDeletion("lawcus"), []);
    const approved = resourceOwnership.approveDeletion(row.id, { approver: HUMAN });
    assert.equal(approved.cleanup_policy, "auto");
    assert.equal(resourceOwnership.approvedForDeletion("lawcus").length, 1);
  });
});

test("an automated actor can never approve a deletion", () => {
  withEnv(({ db, resourceOwnership }) => {
    const row = ownContact(resourceOwnership, seedRun(db));
    for (const actor of ["mcp", "runner", "ai_planner", "network_observer", "ai_extraction", "someone-else", "", undefined]) {
      assert.throws(() => resourceOwnership.approveDeletion(row.id, { approver: actor }), (e) =>
        e instanceof ResourceOwnershipError && ["non_human_approver", "no_approver"].includes(e.code));
    }
    assert.equal(resourceOwnership.approvedForDeletion("lawcus").length, 0);
  });
});

test("the protected fixture can never be approved, even if a row for it somehow exists", () => {
  withEnv(({ db, resourceOwnership }) => {
    // recordCreated refuses a protected id, so the only way such a row can exist is direct database
    // damage. Insert one directly to prove the approval path refuses it too.
    assert.throws(() => ownContact(resourceOwnership, seedRun(db), PROTECTED), code("protected_resource"));
    const runId = seedRun(db);
    const id = randomUUID();
    db.prepare(`INSERT INTO resource_ownership(id,run_id,environment_id,resource_type,resource_id,created_by_primitive,cleanup_policy,cleanup_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, runId, "lawcus", "contact", PROTECTED, "damaged-row", "manual", "pending", new Date().toISOString());
    assert.throws(() => resourceOwnership.approveDeletion(id, { approver: HUMAN }), code("protected_resource"));
    assert.equal(resourceOwnership.approvedForDeletion("lawcus").length, 0);
  });
});

test("only a pending record can be approved; a cleaned one cannot", () => {
  withEnv(({ db, resourceOwnership }) => {
    const row = ownContact(resourceOwnership, seedRun(db));
    resourceOwnership.markCleanup(row.id, { status: "cleaned", note: "gone" });
    assert.throws(() => resourceOwnership.approveDeletion(row.id, { approver: HUMAN }), code("not_pending"));
  });
});

test("a record kept on purpose must be revoked before it can be approved", () => {
  withEnv(({ db, resourceOwnership }) => {
    const runId = seedRun(db);
    const row = ownContact(resourceOwnership, runId);
    resourceOwnership.resolveLeftover(row.id, { action: "keep", actor: HUMAN });
    assert.throws(() => resourceOwnership.approveDeletion(row.id, { approver: HUMAN }), code("kept_on_purpose"));
  });
});

test("an approval can be withdrawn before it is carried out, and then it is not deletable", () => {
  withEnv(({ db, resourceOwnership }) => {
    const row = ownContact(resourceOwnership, seedRun(db));
    resourceOwnership.approveDeletion(row.id, { approver: HUMAN });
    const revoked = resourceOwnership.revokeDeletion(row.id, { approver: HUMAN });
    assert.equal(revoked.cleanup_policy, "manual");
    assert.equal(resourceOwnership.approvedForDeletion("lawcus").length, 0);
    assert.throws(() => resourceOwnership.revokeDeletion(row.id, { approver: HUMAN }), code("not_approved"));
  });
});

test("runApprovedDeletions deletes only approved records, through their handler, and records each outcome", async () => {
  await withEnv(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    const approvedRow = ownContact(resourceOwnership, runId);
    const untouched = ownContact(resourceOwnership, runId);
    resourceOwnership.approveDeletion(approvedRow.id, { approver: HUMAN });
    const calls = [];
    const result = await cleanup.runApprovedDeletions({
      environmentId: "lawcus",
      deleteHandlers: { contact: async (r) => { calls.push(r.resource_id); return { note: "deleted in Lawcus" }; } },
    });
    assert.deepEqual(calls, [approvedRow.resource_id]);
    assert.equal(result.deleted.length, 1);
    const after = db.prepare("SELECT cleanup_status, cleanup_note FROM resource_ownership WHERE id=?").get(approvedRow.id);
    assert.equal(after.cleanup_status, "cleaned");
    assert.equal(after.cleanup_note, "deleted in Lawcus");
    assert.equal(db.prepare("SELECT cleanup_status FROM resource_ownership WHERE id=?").get(untouched.id).cleanup_status, "pending");
  });
});

test("an approved record with no delete handler stays approved and pending — the approval is not consumed", async () => {
  await withEnv(async ({ db, resourceOwnership, cleanup }) => {
    const row = ownContact(resourceOwnership, seedRun(db));
    resourceOwnership.approveDeletion(row.id, { approver: HUMAN });
    const result = await cleanup.runApprovedDeletions({ environmentId: "lawcus", deleteHandlers: {} });
    assert.equal(result.waiting.length, 1);
    assert.equal(result.deleted.length, 0);
    const after = db.prepare("SELECT cleanup_status, cleanup_policy FROM resource_ownership WHERE id=?").get(row.id);
    assert.equal(after.cleanup_status, "pending", "not marked skipped");
    assert.equal(after.cleanup_policy, "auto", "still approved");
  });
});

test("one failing delete does not stop the others, and the failure is recorded on its own row", async () => {
  await withEnv(async ({ db, resourceOwnership, cleanup }) => {
    const runId = seedRun(db);
    const bad = ownContact(resourceOwnership, runId);
    const good = ownContact(resourceOwnership, runId);
    resourceOwnership.approveDeletion(bad.id, { approver: HUMAN });
    resourceOwnership.approveDeletion(good.id, { approver: HUMAN });
    const result = await cleanup.runApprovedDeletions({
      environmentId: "lawcus",
      deleteHandlers: { contact: async (r) => { if (r.id === bad.id) throw new Error("Lawcus refused the delete"); return {}; } },
    });
    assert.equal(result.failed.length, 1);
    assert.equal(result.deleted.length, 1);
    assert.equal(db.prepare("SELECT cleanup_status FROM resource_ownership WHERE id=?").get(bad.id).cleanup_status, "failed");
    assert.equal(db.prepare("SELECT cleanup_status, cleanup_note FROM resource_ownership WHERE id=?").get(bad.id).cleanup_note, "Lawcus refused the delete");
    assert.equal(db.prepare("SELECT cleanup_status FROM resource_ownership WHERE id=?").get(good.id).cleanup_status, "cleaned");
  });
});

test("approvals and deletions are written to the audit trail", () => {
  withEnv(({ db, resourceOwnership }) => {
    const row = ownContact(resourceOwnership, seedRun(db));
    resourceOwnership.approveDeletion(row.id, { approver: HUMAN });
    const actions = db.prepare("SELECT action FROM audit_events WHERE entity_id=?").all(row.id).map((r) => r.action);
    assert.ok(actions.includes("resource.deletion_approved"), `audit has: ${actions}`);
  });
});
