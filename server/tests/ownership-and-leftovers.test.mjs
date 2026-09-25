import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { openResourceOwnership, ResourceOwnershipError } from "../core/resource-ownership.mjs";
import { openResourceLocks } from "../core/resource-locks.mjs";
import { createCleanupRunner } from "../core/cleanup.mjs";
import { closeOutCleanup } from "../core/run-cleanup.mjs";
import { finalizeRun } from "../core/run-outcome.mjs";
import { executeImpactedTest } from "../core/impacted-testing.mjs";
import { buildNativeRunners, seedLawcusNativeCases, PROTECTED_RESOURCE_IDS } from "../testbook/lawcus-native-cases.mjs";
import { runApprovedSuite } from "../mcp/tools.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-ownership-"));
  try {
    const { db, audit } = openStore(dir);
    const resourceOwnership = openResourceOwnership(db, audit, { protectedResourceIds: PROTECTED_RESOURCE_IDS });
    const mutationJournal = openMutationJournal(db, audit);
    const cleanupRunner = createCleanupRunner({ resourceOwnership, mutationJournal, resourceLocks: openResourceLocks(db, audit) });
    return fn({ db, audit, dir, resourceOwnership, mutationJournal, cleanupRunner, testbook: openTestBook(db, audit), apiContracts: openApiContracts(db, audit) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db, { status = "running" } = {}) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, status, 0, new Date().toISOString());
  return runId;
}

const uuid = () => randomUUID();
const okCreate = (id) => async () => ({ uuid: id, correlation: { contractMatch: true, cardinalityOk: true }, missing: [], picked: {} });
const owned = (resourceOwnership, runId) => resourceOwnership.forRun(runId);

// ---------- resource-ownership ----------

test("a protected fixture id can never be recorded as created, whatever a check claims", () => {
  withApp(({ db, resourceOwnership }) => {
    const runId = seedRun(db);
    for (const id of PROTECTED_RESOURCE_IDS) {
      assert.throws(
        () => resourceOwnership.recordCreated({ runId, environmentId: "lawcus", resourceType: "contact", resourceId: id, createdByPrimitive: "x", cleanupPolicy: "manual" }),
        (e) => e instanceof ResourceOwnershipError && e.code === "protected_resource",
      );
    }
    assert.equal(PROTECTED_RESOURCE_IDS.length, 3);
    assert.equal(owned(resourceOwnership, runId).length, 0);
  });
});

test("only a UNIQUE violation is 'already_owned'; a bad run id is a different error", () => {
  withApp(({ db, resourceOwnership }) => {
    const runId = seedRun(db);
    const base = { environmentId: "lawcus", resourceType: "contact", resourceId: "dup-1", createdByPrimitive: "x", cleanupPolicy: "manual" };
    resourceOwnership.recordCreated({ runId, ...base });
    assert.throws(() => resourceOwnership.recordCreated({ runId, ...base }), (e) => e.code === "already_owned");
    assert.throws(
      () => resourceOwnership.recordCreated({ runId: randomUUID(), ...base, resourceId: "other" }),
      (e) => !(e instanceof ResourceOwnershipError) && /FOREIGN KEY/i.test(e.message),
    );
  });
});

test("leftovers: manual/pending, failed and skipped count; retained, cleaned and already-missing do not", () => {
  withApp(({ db, resourceOwnership }) => {
    const runId = seedRun(db);
    const mk = (id, cleanupPolicy = "manual") =>
      resourceOwnership.recordCreated({ runId, environmentId: "lawcus", resourceType: "contact", resourceId: id, createdByPrimitive: "x", cleanupPolicy });
    const manual = mk("m"), failed = mk("f"), skipped = mk("s"), cleaned = mk("c"), missing = mk("x"), retained = mk("r", "retain");
    resourceOwnership.markCleanup(failed.id, { status: "failed" });
    resourceOwnership.markCleanup(skipped.id, { status: "skipped" });
    resourceOwnership.markCleanup(cleaned.id, { status: "cleaned" });
    resourceOwnership.markCleanup(missing.id, { status: "already_missing" });
    const ids = resourceOwnership.leftoversForRun(runId).map((r) => r.resource_id).sort();
    assert.deepEqual(ids, ["f", "m", "s"]);
    assert.deepEqual(resourceOwnership.allLeftovers().map((r) => r.resource_id).sort(), ["f", "m", "s"]);
    assert.ok(retained && manual);
  });
});

test("a person can resolve a leftover: 'removed' closes it, 'keep' retains it; neither touches anything else", () => {
  withApp(({ db, resourceOwnership }) => {
    const runId = seedRun(db);
    const a = resourceOwnership.recordCreated({ runId, environmentId: "lawcus", resourceType: "contact", resourceId: "a", createdByPrimitive: "x", cleanupPolicy: "manual" });
    const b = resourceOwnership.recordCreated({ runId, environmentId: "lawcus", resourceType: "contact", resourceId: "b", createdByPrimitive: "x", cleanupPolicy: "manual" });
    const removed = resourceOwnership.resolveLeftover(a.id, { action: "removed", actor: "operator:test", note: "deleted in Lawcus" });
    assert.equal(removed.cleanup_status, "cleaned");
    assert.match(removed.cleanup_note, /Removed manually by operator:test: deleted in Lawcus/);
    const kept = resourceOwnership.resolveLeftover(b.id, { action: "keep", actor: "operator:test" });
    assert.equal(kept.cleanup_policy, "retain");
    assert.equal(resourceOwnership.leftoversForRun(runId).length, 0);
    assert.throws(() => resourceOwnership.resolveLeftover(a.id, { action: "removed", actor: "x" }), (e) => e.code === "not_leftover", "cannot resolve twice");
    assert.throws(() => resourceOwnership.resolveLeftover(randomUUID(), { action: "removed", actor: "x" }), (e) => e.code === "not_found");
    assert.throws(() => resourceOwnership.resolveLeftover(a.id, { action: "delete-it", actor: "x" }), (e) => e.code === "invalid_action");
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='resource.leftover_resolved'").get(), "the human decision is audited");
  });
});

// ---------- native runners record what they create ----------

function runners(ctx, runId, impl) {
  return buildNativeRunners({ apiContracts: ctx.apiContracts, mutationJournal: ctx.mutationJournal, runId, resourceOwnership: ctx.resourceOwnership, impl });
}

test("each create check records exactly the record it created, as a manual-cleanup pending leftover", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const ids = { contact: uuid(), all: uuid(), company: uuid(), lead: uuid() };
    const r = runners(ctx, runId, {
      runContactCreationCheck: okCreate(ids.contact),
      runContactAllFieldsCreationCheck: okCreate(ids.all),
      runContactCompanyCreationCheck: okCreate(ids.company),
      runLeadCreationCheck: okCreate(ids.lead),
    });
    await r["contacts.create_new_verifies_custom_fields"]();
    await r["contacts.create_all_fields_verified_on_detail_page"]();
    await r["contacts.create_new_company_verifies_custom_fields"]();
    await r["leads.create_new_verifies_custom_fields"]();
    const rows = owned(ctx.resourceOwnership, runId);
    assert.deepEqual(rows.map((x) => [x.resource_type, x.resource_id]).sort(), [["contact", ids.all], ["contact", ids.company], ["contact", ids.contact], ["lead", ids.lead]].sort());
    assert.ok(rows.every((x) => x.cleanup_policy === "manual" && x.cleanup_status === "pending" && x.environment_id === "lawcus"));
    assert.ok(rows.every((x) => x.display_name && x.created_by_primitive));
    assert.match(rows.find((x) => x.resource_type === "lead").display_name, /linked contact\/matter records are not tracked/);
  });
});

test("a create check that FAILED its assertions still records the record it created", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const id = uuid();
    const r = runners(ctx, runId, {
      runContactCreationCheck: async () => ({ uuid: id, correlation: { contractMatch: false, cardinalityOk: true, mismatchReason: "bad shape" } }),
    });
    const outcome = await r["contacts.create_new_verifies_custom_fields"]();
    assert.equal(outcome.passed, false);
    assert.deepEqual(owned(ctx.resourceOwnership, runId).map((x) => x.resource_id), [id]);
  });
});

test("the billing-rate check records the contact it saves, and one the blocked half wrongly created", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const saved = uuid(), wrong = uuid();
    const r = runners(ctx, runId, {
      runContactBillingRateValidationCheck: async () => ({ blockedMessageCount: 1, noContactCreatedWhenBlank: false, createdAfterFilling: true, rateShownCorrectly: true, uuid: saved, blockedCreatedUuid: wrong }),
    });
    await r["contacts.create_billing_rate_required_validation"]();
    assert.deepEqual(owned(ctx.resourceOwnership, runId).map((x) => x.resource_id).sort(), [saved, wrong].sort());

    const runId2 = seedRun(ctx.db, { status: "passed" });
    const r2 = runners(ctx, runId2, { runContactBillingRateValidationCheck: async () => ({ blockedMessageCount: 1, noContactCreatedWhenBlank: true, createdAfterFilling: false, rateShownCorrectly: false, uuid: null, blockedCreatedUuid: null }) });
    await r2["contacts.create_billing_rate_required_validation"]();
    assert.equal(owned(ctx.resourceOwnership, runId2).length, 0, "nothing created, nothing recorded");
  });
});

test("a possible partial creation (Save clicked, no uuid confirmed) is recorded as a 'may exist' leftover and the failure still surfaces", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const r = runners(ctx, runId, {
      runContactCreationCheck: async () => { throw new Error("Could not determine the created contact's uuid from the post-save URL: https://x/contacts"); },
      runLeadCreationCheck: async () => { throw new Error("Could not determine the created lead's uuid from the post-save URL: https://x/leads"); },
    });
    await assert.rejects(r["contacts.create_new_verifies_custom_fields"](), /Could not determine the created contact's uuid/);
    await assert.rejects(r["leads.create_new_verifies_custom_fields"](), /Could not determine the created lead's uuid/);
    const rows = owned(ctx.resourceOwnership, runId);
    assert.deepEqual(rows.map((x) => x.resource_type).sort(), ["contact_unconfirmed", "lead_unconfirmed"]);
    assert.ok(rows.every((x) => /MAY EXIST/.test(x.display_name) && x.cleanup_policy === "manual"));
  });
});

test("an error from BEFORE Save is not recorded as a possible leftover", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const r = runners(ctx, runId, { runContactCreationCheck: async () => { throw new Error("locator.waitFor: Timeout 35000ms exceeded."); } });
    await assert.rejects(r["contacts.create_new_verifies_custom_fields"](), /Timeout/);
    assert.equal(owned(ctx.resourceOwnership, runId).length, 0);
  });
});

test("if recording a possible leftover itself fails, the original error survives and says so", async () => {
  await withApp(async (ctx) => {
    const ghostRun = randomUUID(); // no such run: the ownership insert will fail
    const r = runners(ctx, ghostRun, { runContactCreationCheck: async () => { throw new Error("Could not determine the created contact's uuid from the post-save URL: u"); } });
    await assert.rejects(r["contacts.create_new_verifies_custom_fields"](), (e) => /Could not determine/.test(e.message) && /failed to record a possible leftover/i.test(e.message));
  });
});

test("a check that 'creates' a protected fixture id fails loudly instead of being tracked", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const r = runners(ctx, runId, { runContactCreationCheck: okCreate(PROTECTED_RESOURCE_IDS[0]) });
    await assert.rejects(r["contacts.create_new_verifies_custom_fields"](), (e) => e.code === "protected_resource");
    assert.equal(owned(ctx.resourceOwnership, runId).length, 0);
  });
});

test("checks that create nothing record nothing (validation-only and update checks)", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    const upd = { updateVerified: true, restored: true, updateCorrelation: { contractMatch: true }, restoreCorrelation: { contractMatch: true } };
    const r = runners(ctx, runId, {
      runContactMandatoryFieldValidationCheck: async () => ({ messageCount: 2, noContactCreated: true }),
      runContactPhoneValidationCheck: async () => ({ invalidMessageShown: true, noContactCreated: true }),
      runContactCompanyMandatoryFieldValidationCheck: async () => ({ messageCount: 1, noContactCreated: true }),
      runLeadMandatoryFieldValidationCheck: async () => ({ messageCount: 2, stayedOnStep1: true, noLeadCreated: true }),
      runContactCustomFieldCheck: async () => upd,
      runLeadCustomFieldCheck: async () => upd,
    });
    for (const id of ["contacts.create_mandatory_field_validation", "contacts.create_phone_number_validation", "contacts.create_company_mandatory_field_validation", "leads.create_mandatory_field_validation", "contacts.custom_field_update_existing", "contacts.custom_field_update_existing_company", "leads.custom_field_update_existing"]) {
      await r[id]();
    }
    assert.equal(owned(ctx.resourceOwnership, runId).length, 0);
  });
});

test("without an ownership registry the runners still run (recording is a no-op, not a crash)", async () => {
  await withApp(async (ctx) => {
    const r = buildNativeRunners({ apiContracts: ctx.apiContracts, mutationJournal: ctx.mutationJournal, runId: seedRun(ctx.db), impl: { runContactCreationCheck: okCreate(uuid()) } });
    assert.equal((await r["contacts.create_new_verifies_custom_fields"]()).passed, true);
  });
});

// ---------- the app path end to end: execute -> finalize -> cleanup close-out ----------

function cell(externalId) { return { featureName: "Contacts", recordState: "n/a", externalId, covered: true }; }

async function runThroughAppPath(ctx, impl, externalIds) {
  const runId = seedRun(ctx.db);
  seedLawcusNativeCases(ctx.testbook);
  const results = await executeImpactedTest({
    plan: { cells: externalIds.map(cell) }, runners: runners(ctx, runId, impl), db: ctx.db, runId, testbook: ctx.testbook, delayBetweenRunsMs: 0,
  });
  finalizeRun(ctx.db, runId, { results });
  const cleanup = await closeOutCleanup({ db: ctx.db, cleanupRunner: ctx.cleanupRunner, runId, audit: ctx.audit });
  return { runId, cleanup, run: ctx.db.prepare("SELECT status, outcome, cleanup_status, summary FROM runs WHERE id=?").get(runId) };
}

test("a passing run that created a record is NOT 'cleanup: passed' — it is needs_review and says what remains", async () => {
  await withApp(async (ctx) => {
    const { run, cleanup } = await runThroughAppPath(ctx, { runContactCreationCheck: okCreate(uuid()) }, ["contacts.create_new_verifies_custom_fields"]);
    assert.equal(run.status, "passed", "cleanup never changes the run's own pass/fail");
    assert.equal(run.cleanup_status, "needs_review");
    assert.match(run.summary, /1 record\(s\) created by this run remain in staging/);
    assert.equal(cleanup.leftovers.length, 1);
  });
});

test("a run that created nothing has a genuinely clean cleanup", async () => {
  await withApp(async (ctx) => {
    const { run } = await runThroughAppPath(ctx, { runContactMandatoryFieldValidationCheck: async () => ({ messageCount: 2, noContactCreated: true }) }, ["contacts.create_mandatory_field_validation"]);
    assert.equal(run.cleanup_status, "passed");
    assert.doesNotMatch(run.summary, /remain in staging/);
  });
});

test("an interrupted field update is reported as possibly not restored", async () => {
  await withApp(async (ctx) => {
    const runId = seedRun(ctx.db);
    ctx.mutationJournal.recordBeforeState({ runId, environmentId: "lawcus", resourceType: "contact_custom_field", resourceId: "u:Custom Text", beforeState: { value: "" }, primitiveId: "p", restorationStrategy: "s" });
    finalizeRun(ctx.db, runId, { results: [{ executed: true, status: "passed" }] });
    const c = await closeOutCleanup({ db: ctx.db, cleanupRunner: ctx.cleanupRunner, runId, audit: ctx.audit });
    assert.equal(c.overall, "needs_review");
    assert.match(ctx.db.prepare("SELECT summary FROM runs WHERE id=?").get(runId).summary, /1 field change\(s\) may not have been restored/);
  });
});

test("closeOutCleanup: no runner leaves cleanup_status NULL (unknown, never 'passed'); a crashing runner records 'failed'", async () => {
  await withApp(async (ctx) => {
    const a = seedRun(ctx.db, { status: "passed" });
    assert.equal(await closeOutCleanup({ db: ctx.db, cleanupRunner: undefined, runId: a, audit: ctx.audit }), null);
    assert.equal(ctx.db.prepare("SELECT cleanup_status FROM runs WHERE id=?").get(a).cleanup_status, null);
    const b = seedRun(ctx.db, { status: "passed" });
    const res = await closeOutCleanup({ db: ctx.db, cleanupRunner: { runCleanup: async () => { throw new Error("boom"); } }, runId: b, audit: ctx.audit });
    assert.equal(res.overall, "failed");
    assert.equal(ctx.db.prepare("SELECT cleanup_status FROM runs WHERE id=?").get(b).cleanup_status, "failed");
  });
});

test("MCP run tools close out cleanup too (cleanup_status is recorded, not left NULL)", async () => {
  await withApp(async (ctx) => {
    // Nothing seeded, so nothing is runnable and no check executes.
    const out = await runApprovedSuite(
      { db: ctx.db, testbook: ctx.testbook, apiContracts: ctx.apiContracts, mutationJournal: ctx.mutationJournal, audit: ctx.audit, resourceOwnership: ctx.resourceOwnership, cleanupRunner: ctx.cleanupRunner },
      { suiteName: "Create Contact - Person" },
    );
    assert.equal(out.cleanup, "passed");
    assert.equal(ctx.db.prepare("SELECT cleanup_status FROM runs WHERE id=?").get(out.runId).cleanup_status, "passed");
  });
});
