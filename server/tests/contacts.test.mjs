import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { readContact, updateContactCustomField, verifyContactCustomFieldValue, restoreContactCustomField } from "../core/contacts.mjs";

function withJournal(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-contacts-"));
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
 * answers from a small in-memory contact fixture, so these tests exercise
 * contacts.mjs's own orchestration logic without any real network access. */
function fakeApiClient(initialContact) {
  let contact = structuredClone(initialContact);
  const calls = [];
  return {
    calls,
    async execute({ environmentId, semanticId, pathParams, requestBody }) {
      calls.push({ environmentId, semanticId, pathParams, requestBody: requestBody ? structuredClone(requestBody) : null });
      if (semanticId === "lawcus.contacts.read") return { status: 200, body: structuredClone(contact) };
      if (semanticId === "lawcus.contacts.update") {
        contact = {
          ...contact,
          custom_fields: requestBody.custom_fields.map((f) => {
            const existing = contact.custom_fields.find((e) => e.teamCustomFieldId === f.team_custom_field_id);
            return existing ? { ...existing, value: f.value } : { teamCustomFieldId: f.team_custom_field_id, name: "Unknown", value: f.value, type: "TEXT" };
          }),
        };
        return { status: 200, body: structuredClone(contact) };
      }
      throw new Error(`Unexpected semanticId in test: ${semanticId}`);
    },
  };
}

const BASE_CONTACT = {
  id: 692427,
  uuid: "e2bf71a0-ae87-11f1-ab8e-f18331cbd381",
  name: "QA Batch Test",
  custom_fields: [
    { teamCustomFieldId: 8, name: "Custom Number", value: "", type: "INTEGER" },
    { teamCustomFieldId: 9, name: "Custom Text", value: "", type: "TEXT" },
  ],
};

test("readContact returns the contact body from the Safe API Executor", () => {
  return (async () => {
    const apiClient = fakeApiClient(BASE_CONTACT);
    const contact = await readContact({ apiClient, environmentId: "lawcus", uuid: BASE_CONTACT.uuid });
    assert.equal(contact.name, "QA Batch Test");
  })();
});

test("updateContactCustomField requires a runId and fails fast, not with an opaque DB error", () => {
  return withJournal(async (journal) => {
    const apiClient = fakeApiClient(BASE_CONTACT);
    await assert.rejects(
      updateContactCustomField({
        apiClient, mutationJournal: journal, environmentId: "lawcus",
        uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, newValue: "x", primitiveId: "contacts.update_custom_field",
      }),
      /requires a runId/,
    );
  });
});

test("updateContactCustomField sends only the changed field's value, never the whole contact form", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_CONTACT);
    await updateContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, newValue: "hello", primitiveId: "contacts.update_custom_field",
    });
    const updateCall = apiClient.calls.find((c) => c.semanticId === "lawcus.contacts.update");
    assert.deepEqual(updateCall.requestBody.custom_fields, [
      { team_custom_field_id: 8, value: "" },
      { team_custom_field_id: 9, value: "hello" },
    ]);
  });
});

test("updateContactCustomField records the true before-value to the mutation journal before making any write", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_CONTACT);
    const { journalEntry, beforeValue } = await updateContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, newValue: "hello", primitiveId: "contacts.update_custom_field",
    });
    assert.equal(beforeValue, "");
    assert.deepEqual(journalEntry.beforeState, { value: "", fieldExisted: true });
    assert.equal(journalEntry.resource_type, "contact_custom_field");
    assert.equal(journalEntry.restoration_status, "pending");
  });
});

test("updateContactCustomField appends a new entry when the field wasn't previously recorded on the contact", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const contactWithoutField = { ...BASE_CONTACT, custom_fields: [{ teamCustomFieldId: 8, name: "Custom Number", value: "", type: "INTEGER" }] };
    const apiClient = fakeApiClient(contactWithoutField);
    const { beforeValue } = await updateContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, newValue: "new", primitiveId: "contacts.update_custom_field",
    });
    assert.equal(beforeValue, "");
    const updateCall = apiClient.calls.find((c) => c.semanticId === "lawcus.contacts.update");
    assert.deepEqual(updateCall.requestBody.custom_fields, [
      { team_custom_field_id: 8, value: "" },
      { team_custom_field_id: 9, value: "new" },
    ]);
  });
});

test("verifyContactCustomFieldValue independently re-reads rather than trusting a prior response", () => {
  return (async () => {
    const apiClient = fakeApiClient({ ...BASE_CONTACT, custom_fields: [{ teamCustomFieldId: 9, name: "Custom Text", value: "already-set", type: "TEXT" }] });
    const result = await verifyContactCustomFieldValue({
      apiClient, environmentId: "lawcus", uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, expectedValue: "already-set",
    });
    assert.equal(result.matches, true);
    const wrong = await verifyContactCustomFieldValue({
      apiClient, environmentId: "lawcus", uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, expectedValue: "something-else",
    });
    assert.equal(wrong.matches, false);
    assert.equal(wrong.actualValue, "already-set");
  })();
});

test("restoreContactCustomField sets the field back and records the journal entry as restored", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_CONTACT);
    const { journalEntry } = await updateContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, newValue: "temporary", primitiveId: "contacts.update_custom_field",
    });
    const { verify } = await restoreContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus",
      journalEntryId: journalEntry.id, uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, beforeValue: "",
    });
    assert.equal(verify.matches, true);
    assert.equal(verify.actualValue, "");
    const entry = journal.forRun(runId).find((e) => e.id === journalEntry.id);
    assert.equal(entry.restoration_status, "restored");
  });
});

test("restoreContactCustomField records 'conflict', not 'restored', when the persisted value doesn't match after writing", () => {
  return withJournal(async (journal, db) => {
    const runId = seedRun(db);
    const apiClient = fakeApiClient(BASE_CONTACT);
    // Simulate a concurrent external change: this fake ignores whatever
    // restoreContactCustomField asks for on field 9, always persisting a
    // fixed "someone-else-wrote-this" instead — so independent
    // verification (section 24), not just a 200 status, is what has to
    // catch the mismatch.
    const realUpdate = apiClient.execute.bind(apiClient);
    apiClient.execute = async (args) => {
      if (args.semanticId === "lawcus.contacts.update") {
        args = { ...args, requestBody: { ...args.requestBody, custom_fields: args.requestBody.custom_fields.map((f) => f.team_custom_field_id === 9 ? { ...f, value: "someone-else-wrote-this" } : f) } };
      }
      return realUpdate(args);
    };
    const { journalEntry } = await updateContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus", runId,
      uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, newValue: "temporary", primitiveId: "contacts.update_custom_field",
    });
    const { verify } = await restoreContactCustomField({
      apiClient, mutationJournal: journal, environmentId: "lawcus",
      journalEntryId: journalEntry.id, uuid: BASE_CONTACT.uuid, teamCustomFieldId: 9, beforeValue: "",
    });
    assert.equal(verify.matches, false);
    assert.equal(verify.actualValue, "someone-else-wrote-this");
    const entry = journal.forRun(runId).find((e) => e.id === journalEntry.id);
    assert.equal(entry.restoration_status, "conflict");
    assert.match(entry.restoration_note, /someone-else-wrote-this/);
  });
});
