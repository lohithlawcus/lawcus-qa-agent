// V5 Step 15 — Leads. Thin orchestration over the existing Safe API
// Executor (Step 10) and Mutation Journal (Step 13), mirroring
// contacts.mjs. A Lead is a Matter-shaped record (status "LEAD"); its
// matter-level custom field VALUEs are a mutation to an EXISTING resource,
// so this goes through the journal, not resource-ownership.
//
// Same known gap as contacts.mjs: api-client.mjs has no session/auth
// support, so these functions are correct and unit-tested against a fake
// client but UNPROVEN live — real writes go through leads-browser.mjs
// instead, per the user's "option 2, browser-driven for writes" decision.

export async function readLead({ apiClient, environmentId, uuid }) {
  const result = await apiClient.execute({ environmentId, semanticId: "lawcus.leads.read", pathParams: { uuid } });
  return result.body;
}

/**
 * Sends only the one matter-level custom field actually being changed
 * (plus every other matter custom field already recorded, unchanged) via
 * the real PUT /leads endpoint, which is identified by matter_uuid in the
 * body rather than a :uuid path segment. Records before-state to the
 * Mutation Journal first.
 *
 * runId is required for the same reason as contacts.mjs's equivalent:
 * mutation_journal.run_id is NOT NULL.
 */
export async function updateLeadCustomField({
  apiClient,
  mutationJournal,
  environmentId,
  runId,
  uuid,
  teamCustomFieldId,
  newValue,
  primitiveId,
}) {
  if (!runId) throw new Error("updateLeadCustomField requires a runId — every mutation must be attributable to an exact run.");
  const before = await readLead({ apiClient, environmentId, uuid });
  const existingFields = before.custom_fields || [];
  const beforeField = existingFields.find((f) => f.teamCustomFieldId === teamCustomFieldId);
  const beforeValue = beforeField ? beforeField.value : "";

  const journalEntry = mutationJournal.recordBeforeState({
    runId,
    environmentId,
    resourceType: "lead_custom_field",
    resourceId: `${uuid}:${teamCustomFieldId}`,
    beforeState: { value: beforeValue, fieldExisted: Boolean(beforeField) },
    primitiveId,
    restorationStrategy: "PUT /leads with matter_uuid set to this lead and this field's team_custom_field_id set back to before-state.value.",
  });

  const matterCustomFields = beforeField
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
    semanticId: "lawcus.leads.update",
    requestBody: { matter_uuid: uuid, matter_custom_fields: matterCustomFields },
    runId,
  });

  return { journalEntry, result, beforeValue };
}

/** Independent confirmation (section 24) — reads the lead fresh and checks
 * the field's persisted value, rather than trusting the update call's own
 * response body. */
export async function verifyLeadCustomFieldValue({ apiClient, environmentId, uuid, teamCustomFieldId, expectedValue }) {
  const lead = await readLead({ apiClient, environmentId, uuid });
  const field = (lead.custom_fields || []).find((f) => f.teamCustomFieldId === teamCustomFieldId);
  return { matches: (field?.value ?? "") === expectedValue, actualValue: field?.value ?? null, lead };
}

export async function restoreLeadCustomField({
  apiClient,
  mutationJournal,
  environmentId,
  journalEntryId,
  uuid,
  teamCustomFieldId,
  beforeValue,
}) {
  const current = await readLead({ apiClient, environmentId, uuid });
  const matterCustomFields = (current.custom_fields || []).map((f) => ({
    team_custom_field_id: f.teamCustomFieldId,
    value: f.teamCustomFieldId === teamCustomFieldId ? beforeValue : f.value,
  }));
  const result = await apiClient.execute({
    environmentId,
    semanticId: "lawcus.leads.update",
    requestBody: { matter_uuid: uuid, matter_custom_fields: matterCustomFields },
  });
  const verify = await verifyLeadCustomFieldValue({ apiClient, environmentId, uuid, teamCustomFieldId, expectedValue: beforeValue });
  mutationJournal.recordRestoration(journalEntryId, {
    status: verify.matches ? "restored" : "conflict",
    note: verify.matches ? null : `Expected "${beforeValue}", found "${verify.actualValue}" after restoration.`,
  });
  return { result, verify };
}
