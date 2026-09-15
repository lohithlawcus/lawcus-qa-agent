import { attachNetworkObserver, correlateObservation } from "./network-observer.mjs";
import { STAGING, API_ORIGIN } from "./environment-adapter.mjs";

// V5 Step 15 — Leads, browser-driven (same "option 2" direction as
// contacts-browser.mjs: writes go through the real UI, not a bare API
// call). A Lead is a Matter-shaped record edited through a two-step
// wizard: Step 1 ("Update Lead: Potential Client") edits the linked
// Contact and its CONTACT-scoped custom fields (same fields/form as plain
// Contacts); Step 2 ("Update Lead: Add potential matter") edits the
// Lead/Matter itself and its own MATTER-scoped custom fields — a
// different set of field definitions from Step 1's, both returned by the
// same /v2/customfields list but distinguished by entity_type. This
// module only concerns itself with Step 2's matter-level custom fields;
// section 8's Contact-scoped fields on a Lead are exactly
// contacts-browser.mjs's concern, reachable via Step 1 of the same
// wizard.
//
// Unlike Contacts, the lead detail page's "Edit lead" action has a plain,
// stable text locator — no fixed-viewport-coordinate fallback needed here.
export const VIEWPORT = { width: 1400, height: 900 };

async function openEditMatterCustomFields(page) {
  await page.getByText("Edit lead", { exact: true }).click();
  await page.getByText("Update Lead", { exact: false }).first().waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // "Client Details" appears twice on Step 2 (a sidebar nav label and a
  // section heading in the content area) — .first() avoids a strict-mode
  // violation; either match is equally good evidence Step 2 has rendered.
  await page.getByText("Client Details", { exact: true }).first().waitFor({ timeout: 10000 });
  // "Custom Fields" also matches Step 1's (now unmounted or hidden)
  // sidebar entry in a broad text search, so anchor on the last match —
  // Step 2's, which is what's actually on screen at this point.
  await page.locator("text=Custom Fields").last().click({ force: true });
  await page.waitForTimeout(500);
}

/** Adds a non-default matter custom field to the currently-open Step 2
 * form via its search box, if it isn't already showing. Mirrors
 * contacts-browser.mjs's ensureFieldOnForm. */
async function ensureFieldOnForm(page, fieldName) {
  const already = await page.getByText(fieldName, { exact: true }).count();
  if (already > 0) return;
  await page.getByPlaceholder("Start typing to search").click();
  await page.keyboard.type(fieldName);
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}

function fieldValueInput(page, fieldName) {
  return page.locator(`text=${fieldName}`).locator("..").locator('input[type="text"]').first();
}

/** Opens the lead, reads the named MATTER-scoped custom field's current
 * value, and closes without saving — used both to capture before-state
 * and for independent post-update verification (section 24). */
export async function readLeadCustomFieldViaBrowser({ context, uuid, fieldName }) {
  const page = await context.newPage();
  try {
    await page.goto(`${STAGING}/lead/${uuid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openEditMatterCustomFields(page);
    await ensureFieldOnForm(page, fieldName);
    const value = await fieldValueInput(page, fieldName).inputValue();
    return value;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Sets one lead (matter-level) custom field's value through the real UI
 * and clicks Save — a genuine UI mutation, not an API call. Correlates
 * the network traffic the save actually produced against the approved
 * lawcus.leads.update contract (section 23). Never assumes the save
 * worked just because no error was shown; the caller independently
 * re-reads afterward (readLeadCustomFieldViaBrowser).
 */
export async function updateLeadCustomFieldViaBrowser({ context, apiContracts, uuid, fieldName, newValue }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    await page.goto(`${STAGING}/lead/${uuid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openEditMatterCustomFields(page);
    await ensureFieldOnForm(page, fieldName);
    const valueInput = fieldValueInput(page, fieldName);
    await valueInput.click();
    await valueInput.fill(newValue);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2500);

    const contract = apiContracts.resolveApprovedContract("lawcus.leads.update");
    const correlation = correlateObservation({
      contract,
      events: observer.events,
      host: new URL(API_ORIGIN).hostname,
      cardinality: "exactly_one",
    });
    return { correlation, events: observer.events };
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}

/** Full update -> journal -> independent verify -> restore -> independent
 * re-verify cycle for one lead (matter-level) custom field, all
 * browser-driven. Mirrors contacts-browser.mjs's equivalent (same
 * before/after shape and mutation-journal discipline). */
export async function updateAndRestoreLeadCustomFieldViaBrowser({
  context,
  apiContracts,
  mutationJournal,
  environmentId,
  runId,
  uuid,
  fieldName,
  newValue,
  primitiveId,
}) {
  if (!runId) throw new Error("updateAndRestoreLeadCustomFieldViaBrowser requires a runId.");

  const beforeValue = await readLeadCustomFieldViaBrowser({ context, uuid, fieldName });
  const journalEntry = mutationJournal.recordBeforeState({
    runId,
    environmentId,
    resourceType: "lead_custom_field",
    resourceId: `${uuid}:${fieldName}`,
    beforeState: { value: beforeValue },
    primitiveId,
    restorationStrategy: "Re-open the lead's Step 2 Custom Fields form and set this field back to before-state.value, via the same UI action.",
  });

  const { correlation } = await updateLeadCustomFieldViaBrowser({ context, apiContracts, uuid, fieldName, newValue });
  const afterUpdate = await readLeadCustomFieldViaBrowser({ context, uuid, fieldName });
  const updateVerified = afterUpdate === newValue;

  const { correlation: restoreCorrelation } = await updateLeadCustomFieldViaBrowser({
    context, apiContracts, uuid, fieldName, newValue: beforeValue,
  });
  const afterRestore = await readLeadCustomFieldViaBrowser({ context, uuid, fieldName });
  const restored = afterRestore === beforeValue;

  mutationJournal.recordRestoration(journalEntry.id, {
    status: restored ? "restored" : "conflict",
    note: restored ? null : `Expected "${beforeValue}", found "${afterRestore}" after restoration.`,
  });

  return {
    beforeValue,
    updateCorrelation: correlation,
    updateVerified,
    restoreCorrelation,
    restored,
    journalEntry,
  };
}
