// V5 Step 15 — Contacts + Custom Fields. Thin orchestration over the
// existing Safe API Executor (Step 10) and Mutation Journal (Step 13):
// nothing here makes a raw fetch() or bypasses either. A custom field
// VALUE update is a mutation to an EXISTING resource (the contact already
// existed), so it goes through the journal, not resource-ownership (which
// is for resources a run CREATES — section 25 vs 27).

export async function readContact({ apiClient, environmentId, uuid }) {
  const result = await apiClient.execute({ environmentId, semanticId: "lawcus.contacts.read", pathParams: { uuid } });
  return result.body;
}

/**
 * Sends only the one field actually being changed (plus every field
 * already recorded on the contact, unchanged) — never the contact's whole
 * form state the way the Lawcus UI's own save button does. Records
 * before-state to the Mutation Journal first, so a caller can restore
 * even if the process crashes immediately after this call returns.
 *
 * runId is required, not optional: mutation_journal.run_id is NOT NULL
 * (section 27 — every mutation is attributable to an exact run), so this
 * throws a clear error up front rather than letting an omitted runId
 * surface as an opaque SQLite constraint failure.
 */
export async function updateContactCustomField({
  apiClient,
  mutationJournal,
  environmentId,
  runId,
  uuid,
  teamCustomFieldId,
  newValue,
  primitiveId,
}) {
  if (!runId) throw new Error("updateContactCustomField requires a runId — every mutation must be attributable to an exact run.");
  const before = await readContact({ apiClient, environmentId, uuid });
  const existingFields = before.custom_fields || [];
  const beforeField = existingFields.find((f) => f.teamCustomFieldId === teamCustomFieldId);
  const beforeValue = beforeField ? beforeField.value : "";

  const journalEntry = mutationJournal.recordBeforeState({
    runId,
    environmentId,
    resourceType: "contact_custom_field",
    resourceId: `${uuid}:${teamCustomFieldId}`,
    beforeState: { value: beforeValue, fieldExisted: Boolean(beforeField) },
    primitiveId,
    restorationStrategy: "PUT /contacts/:uuid with this field's team_custom_field_id set back to before-state.value",
  });

  const customFields = beforeField
    ? existingFields.map((f) => ({
        team_custom_field_id: f.teamCustomFieldId,
        value: f.teamCustomFieldId === teamCustomFieldId ? newValue : f.value,
      }))
    : [
        ...existingFields.map((f) => ({ team_custom_field_id: f.teamCustomFieldId, value: f.value })),
        { team_custom_field_id: teamCustomFieldId, value: newValue },
      ];

  const result = await apiClient.execute({
    environmentId,
    semanticId: "lawcus.contacts.update",
    pathParams: { uuid },
    requestBody: { id: before.id, custom_fields: customFields },
    runId,
  });

  return { journalEntry, result, beforeValue };
}

/** Independent confirmation (section 24) — reads the contact fresh and
 * checks the field's persisted value, rather than trusting the update
 * call's own response body. */
export async function verifyContactCustomFieldValue({ apiClient, environmentId, uuid, teamCustomFieldId, expectedValue }) {
  const contact = await readContact({ apiClient, environmentId, uuid });
  const field = (contact.custom_fields || []).find((f) => f.teamCustomFieldId === teamCustomFieldId);
  return { matches: (field?.value ?? "") === expectedValue, actualValue: field?.value ?? null, contact };
}

export async function restoreContactCustomField({
  apiClient,
  mutationJournal,
  environmentId,
  journalEntryId,
  uuid,
  teamCustomFieldId,
  beforeValue,
}) {
  const current = await readContact({ apiClient, environmentId, uuid });
  const customFields = (current.custom_fields || []).map((f) => ({
    team_custom_field_id: f.teamCustomFieldId,
    value: f.teamCustomFieldId === teamCustomFieldId ? beforeValue : f.value,
  }));
  const result = await apiClient.execute({
    environmentId,
    semanticId: "lawcus.contacts.update",
    pathParams: { uuid },
    requestBody: { id: current.id, custom_fields: customFields },
  });
  const verify = await verifyContactCustomFieldValue({ apiClient, environmentId, uuid, teamCustomFieldId, expectedValue: beforeValue });
  mutationJournal.recordRestoration(journalEntryId, {
    status: verify.matches ? "restored" : "conflict",
    note: verify.matches ? null : `Expected "${beforeValue}", found "${verify.actualValue}" after restoration.`,
  });
  return { result, verify };
}
