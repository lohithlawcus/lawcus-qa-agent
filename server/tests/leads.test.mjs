import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { readLead, updateLeadCustomField, verifyLeadCustomFieldValue, restoreLeadCustomField } from "../core/leads.mjs";

function withJournal(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-leads-"));
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
    runbookId, 1, "lawcus", "t", "intent", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(
    runId, runbookId, "passed", 0, new Date().toISOString(),
  );
  return runId;
}

/** A fake Safe API Executor — records every call it was asked to make and
 * answers from a small in-memory lead (Matter-shaped) fixture, so these
 * tests exercise leads.mjs's own orchestration logic without any real
 * network access. Mirrors contacts.test.mjs's fakeApiClient, but the
 * update call is PUT /leads keyed by matter_uuid in the body rather than
 * a :uuid path segment. */
function fakeApiClient(initialLead) {
  let lead = structuredClone(initialLead);
  const calls = [];
  return {
    calls,
    async execute({ environmentId, semanticId, pathParams, requestBody }) {
      calls.push({ environmentId, semanticId, pathParams, requestBody: requestBody ? structuredClone(requestBody) : null });
      if (semanticId === "lawcus.leads.read") return { status: 200, body: structuredClone(lead) };
      if (semanticId === "lawcus.leads.update") {
        lead = {
          ...lead,
          custom_fields: requestBody.matter_custom_fields.map((f) => {
            const existing = lead.custom_fields.find((e) => e.teamCustomFieldId === f.team_custom_field_id);
            return existing ? { ...existing, value: f.value } : { teamCustomFieldId: f.team_custom_field_id, name: "Unknown", value: f.value, type: "TEXT" };
          }),
        };
        return { status: 200, body: { matter: structuredClone(lead) } };
      }
      throw new Error(`Unexpected semanticId in test: ${semanticId}`);
    },
  };
}

const BASE_LEAD = {
  id: 395617,
  uuid: "c59e9ec0-b115-11f1-b4fe-1feb32eda16d",
  name: "QA Batch Test Lead",
  status: "LEAD",
  client_id: 692448,
  custom_fields: [
    { teamCustomFieldId: 21, name: "Custom Text", value: "", type: "TEXT" },
    { teamCustomFieldId: 22, name: "Custom Picklist", value: "", type: "DROPDOWN_LIST" },
  ],
};

test("readLead returns the lead body from the Safe API Executor", () => {
  return (async () => {
    const apiClient = fakeApiClient(BASE_LEAD);
    const lead = await readLead({ apiClient, environmentId: "lawcus", uuid: BASE_LEAD.uuid });
    assert.equal(lead.name, "QA Batch Test Lead");
    assert.equal(lead.status, "LEAD");
  })();
});

test("updateLeadCustomField requires a runId and fails fast, not with an opaque DB error", () => {
  return withJournal(async (journal) => {
    const apiClient = fakeApiClient(BASE_LEAD);
    await assert.rejects(
      updateLeadCustomField({
        apiClient, mutationJournal: journal, environmentId: "lawcus",
        uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, newValue: "x", primitiveId: "leads.update_custom_field",
      }),
      /requires a runId/,
    );
  });
});

test("updateLeadCustomField sends only the changed field's value, keyed by matter_uuid, never a whole-form payload", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_LEAD);
    await updateLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, newValue: "hello", primitiveId: "leads.update_custom_field",
    });
    const updateCall = apiClient.calls.find((c) => c.semanticId === "lawcus.leads.update");
    assert.equal(updateCall.requestBody.matter_uuid, BASE_LEAD.uuid);
    assert.deepEqual(updateCall.requestBody.matter_custom_fields, [
      { team_custom_field_id: 21, value: "hello" },
      { team_custom_field_id: 22, value: "" },
    ]);
  });
});

test("updateLeadCustomField records the true before-value to the mutation journal before making any write", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_LEAD);
    const { journalEntry, beforeValue } = await updateLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, newValue: "hello", primitiveId: "leads.update_custom_field",
    });
    assert.equal(beforeValue, "");
    assert.deepEqual(journalEntry.beforeState, { value: "", fieldExisted: true });
    assert.equal(journalEntry.resource_type, "lead_custom_field");
    assert.equal(journalEntry.restoration_status, "pending");
  });
});

test("updateLeadCustomField appends a new entry when the field wasn't previously recorded on the lead", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const leadWithoutField = { ...BASE_LEAD, custom_fields: [{ teamCustomFieldId: 22, name: "Custom Picklist", value: "", type: "DROPDOWN_LIST" }] };
    const apiClient = fakeApiClient(leadWithoutField);
    const { beforeValue } = await updateLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, newValue: "new", primitiveId: "leads.update_custom_field",
    });
    assert.equal(beforeValue, "");
    const updateCall = apiClient.calls.find((c) => c.semanticId === "lawcus.leads.update");
    assert.deepEqual(updateCall.requestBody.matter_custom_fields, [
      { team_custom_field_id: 22, value: "" },
      { team_custom_field_id: 21, value: "new" },
    ]);
  });
});

test("verifyLeadCustomFieldValue independently re-reads rather than trusting a prior response", () => {
  return (async () => {
    const apiClient = fakeApiClient({ ...BASE_LEAD, custom_fields: [{ teamCustomFieldId: 21, name: "Custom Text", value: "already-set", type: "TEXT" }] });
    const result = await verifyLeadCustomFieldValue({
      apiClient, environmentId: "lawcus", uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, expectedValue: "already-set",
    });
    assert.equal(result.matches, true);
    const wrong = await verifyLeadCustomFieldValue({
      apiClient, environmentId: "lawcus", uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, expectedValue: "something-else",
    });
    assert.equal(wrong.matches, false);
    assert.equal(wrong.actualValue, "already-set");
  })();
});

test("restoreLeadCustomField sets the field back and records the journal entry as restored", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_LEAD);
    const { journalEntry } = await updateLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, newValue: "temporary", primitiveId: "leads.update_custom_field",
    });
    const { verify } = await restoreLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus",
      journalEntryId: journalEntry.id, uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, beforeValue: "",
    });
    assert.equal(verify.matches, true);
    assert.equal(verify.actualValue, "");
    const entry = journal.forRun(runId).find((e) => e.id === journalEntry.id);
    assert.equal(entry.restoration_status, "restored");
  });
});

test("restoreLeadCustomField records 'conflict', not 'restored', when the persisted value doesn't match after writing", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_LEAD);
    const realUpdate = apiClient.execute.bind(apiClient);
    apiClient.execute = async (args) => {
      if (args.semanticId === "lawcus.leads.update") {
        args = { ...args, requestBody: { ...args.requestBody, matter_custom_fields: args.requestBody.matter_custom_fields.map((f) => f.team_custom_field_id === 21 ? { ...f, value: "someone-else-wrote-this" } : f) } };
      }
      return realUpdate(args);
    };
    const { journalEntry } = await updateLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, newValue: "temporary", primitiveId: "leads.update_custom_field",
    });
    const { verify } = await restoreLeadCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus",
      journalEntryId: journalEntry.id, uuid: BASE_LEAD.uuid, teamCustomFieldId: 21, beforeValue: "",
    });
    assert.equal(verify.matches, false);
    assert.equal(verify.actualValue, "someone-else-wrote-this");
    const entry = journal.forRun(runId).find((e) => e.id === journalEntry.id);
    assert.equal(entry.restoration_status, "conflict");
    assert.match(entry.restoration_note, /someone-else-wrote-this/);
  });
});
