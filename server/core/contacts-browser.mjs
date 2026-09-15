import { attachNetworkObserver, correlateObservation } from "./network-observer.mjs";
import { STAGING, API_ORIGIN } from "./environment-adapter.mjs";

// V5 Step 15 — Contacts + Custom Fields, browser-driven (per the user's
// explicit direction: writes go through the real UI, not a bare API call —
// section 24/50's own example flow: "Browser: open Contact Custom Fields,
// perform update, save" is a UI action, with the Network Observer
// validating the resulting real request afterward, not a primitive that
// calls the API directly). Reads are browser-driven for the same reason —
// api-client.mjs (Step 10) has no session/auth support yet, and nothing in
// this module invents one; see contacts.mjs and the project memory note
// for that still-open gap.
//
// KNOWN TESTABILITY GAP (filed as a real TESTABILITY_HOOK_REQUEST
// proposal, not silently worked around): the contact detail page's "Edit
// Contact" icon button has no aria-label, no data-testid, and no stable
// CSS class — its two visual neighbors ("More actions", "Close") do have
// aria-labels, but the DOM's sibling order doesn't match their visual
// order, so anchoring off them doesn't work either. EDIT_BUTTON_POSITION
// below is a real, deliberate fallback to a fixed-viewport coordinate,
// not an oversight — section 29.5: "If no stable locator exists:
// TESTABILITY_HOOK_REQUEST."
// Exported so the context that actually opens this page is created with
// this exact viewport — EDIT_BUTTON_POSITION only means anything at this
// specific size.
export const VIEWPORT = { width: 1400, height: 900 };
const EDIT_BUTTON_POSITION = { x: 1313, y: 85 };

async function openEditCustomFields(page) {
  await page.mouse.click(EDIT_BUTTON_POSITION.x, EDIT_BUTTON_POSITION.y);
  await page.getByText("Edit Contact", { exact: true }).waitFor({ timeout: 10000 });
  await page.getByText("Custom Fields", { exact: true }).first().click();
  await page.waitForTimeout(500);
}

/** Adds a non-default custom field to the currently-open edit form via its
 * search box, if it isn't already showing (default fields always show;
 * non-default ones, like "Custom Text" in this tenant, don't until added
 * this way — section 8's "Default: the field always appears on the form
 * when set"). No-ops if the field is already present. */
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

/** Opens the contact, reads the named custom field's current value, and
 * closes without saving anything — a real, separate navigation used both
 * to capture before-state and for independent post-update verification
 * (section 24). */
export async function readContactCustomFieldViaBrowser({ context, uuid, fieldName }) {
  const page = await context.newPage();
  try {
    await page.goto(`${STAGING}/contact/${uuid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openEditCustomFields(page);
    await ensureFieldOnForm(page, fieldName);
    const value = await page.locator('input[type="text"]').last().inputValue();
    return value;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Sets one contact custom field's value through the real UI and clicks
 * Update — a genuine UI mutation, not an API call. Correlates the
 * network traffic the save actually produced against the approved
 * lawcus.contacts.update contract (section 23), and returns that
 * correlation result alongside the observer's raw events. Never assumes
 * the save worked just because no error was shown; the caller is
 * expected to independently re-read afterward (readContactCustomFieldViaBrowser).
 */
export async function updateContactCustomFieldViaBrowser({ context, apiContracts, uuid, fieldName, newValue }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    await page.goto(`${STAGING}/contact/${uuid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openEditCustomFields(page);
    await ensureFieldOnForm(page, fieldName);
    const valueInput = page.locator('input[type="text"]').last();
    await valueInput.click();
    await valueInput.fill(newValue);
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.waitForTimeout(2500);

    const contract = apiContracts.resolveApprovedContract("lawcus.contacts.update");
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
 * re-verify cycle for one contact custom field, all browser-driven.
 * Mirrors contacts.mjs's direct-API version's contract (same before/after
 * shape and mutation-journal discipline) but never calls the Safe API
 * Executor for the write. */
export async function updateAndRestoreContactCustomFieldViaBrowser({
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
  if (!runId) throw new Error("updateAndRestoreContactCustomFieldViaBrowser requires a runId.");

  const beforeValue = await readContactCustomFieldViaBrowser({ context, uuid, fieldName });
  const journalEntry = mutationJournal.recordBeforeState({
    runId,
    environmentId,
    resourceType: "contact_custom_field",
    resourceId: `${uuid}:${fieldName}`,
    beforeState: { value: beforeValue },
    primitiveId,
    restorationStrategy: "Re-open the contact's Custom Fields edit form and set this field back to before-state.value, via the same UI action.",
  });

  const { correlation } = await updateContactCustomFieldViaBrowser({ context, apiContracts, uuid, fieldName, newValue });
  const afterUpdate = await readContactCustomFieldViaBrowser({ context, uuid, fieldName });
  const updateVerified = afterUpdate === newValue;

  const { correlation: restoreCorrelation } = await updateContactCustomFieldViaBrowser({
    context, apiContracts, uuid, fieldName, newValue: beforeValue,
  });
  const afterRestore = await readContactCustomFieldViaBrowser({ context, uuid, fieldName });
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
