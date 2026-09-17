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

/** Removes a matter custom field from the currently-open Step 2 form via
 * its own (x) control — the real inverse of ensureFieldOnForm's
 * search-to-add. Mirrors contacts-browser.mjs's removeFieldFromForm (same
 * shared component, same "blanking text doesn't persist as cleared"
 * behavior, confirmed live 2026-09-18 on this form too). Anchored on the
 * value input's own element, not the field's label text. No-ops if the
 * row can't be found. */
async function removeFieldFromForm(page, valueInputLocator) {
  const inputHandle = await valueInputLocator.elementHandle();
  if (!inputHandle) return false;
  const removeHandle = await page.evaluateHandle((input) => {
    let row = input;
    for (let i = 0; i < 6 && row.parentElement; i++) {
      row = row.parentElement;
      const btn = Array.from(row.querySelectorAll("button, [role='button']")).find((b) =>
        b.className.includes("deleteIconBtn"),
      );
      if (btn) return btn;
    }
    return null;
  }, inputHandle);
  const removeElement = removeHandle.asElement();
  if (!removeElement) return false;
  await removeElement.click();
  return true;
}

/** Opens the New Lead wizard's Step 1 (Add potential client) from the
 * Leads list — shared by every create/validate case below. Real, observed
 * 2026-09-16: Step 1 defaults to Person, and also offers Company and
 * Existing Contact as potential-client types (same three-way choice as
 * plain Contacts' Person/Company, plus a lead-specific "link to an
 * existing contact" option — not yet covered by any case here). */
async function openNewLeadDialog(page) {
  await page.goto(STAGING + "/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator("text=Leads").first().click();
  await page.waitForTimeout(1500);
  await page.getByText("New Lead", { exact: false }).first().click().catch(async () => {
    await page.getByRole("button", { name: /new/i }).first().click();
    await page.waitForTimeout(500);
    await page.getByText("New Lead", { exact: false }).first().click();
  });
  await page.waitForTimeout(1500);
}

/**
 * Creates a brand-new Lead (Person "Potential Client" + its Matter) through
 * the real "New Lead" two-step wizard and returns its real uuid,
 * correlating the resulting network traffic against the approved
 * lawcus.leads.create contract. Only sets the linked contact's First/Last
 * Name and the lead's Matter Name — every default custom field on both
 * steps is left at its default (empty) value.
 */
export async function createLeadViaBrowser({ context, apiContracts, firstName, lastName, matterName }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    await openNewLeadDialog(page);
    await page.locator('input[name="firstName"], input[placeholder*="First"]').first().fill(firstName);
    await page.locator('input[name="lastName"], input[placeholder*="Last"]').first().fill(lastName);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForTimeout(1200);
    await page.getByLabel("Matter Name", { exact: false }).fill(matterName).catch(async () => {
      await page.locator('input[name="name"], input[placeholder*="Matter Name"]').first().fill(matterName);
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Real observed flakiness (2026-09-16, same shape and root cause as
    // contacts-browser.mjs's createContactViaBrowser — see its comment):
    // a fixed short wait here sometimes sampled the URL while Lawcus was
    // still briefly showing the Leads list, before its own client-side
    // navigation to the new lead's detail page had landed (78s duration
    // observed vs. a normal ~41-62s range — genuinely extra real time
    // elapsed, not a login timeout). Actively wait for the real
    // detail-page URL pattern instead of guessing a fixed delay.
    await page.waitForURL(/\/lead\/[a-f0-9-]{36}/, { timeout: 15000 }).catch(() => {});
    // Real response-body race, same as Contacts — see
    // network-observer.mjs's attachNetworkObserver / settle() comment.
    await observer.settle();

    const contract = apiContracts.resolveApprovedContract("lawcus.leads.create");
    const correlation = correlateObservation({
      contract,
      events: observer.events,
      host: new URL(API_ORIGIN).hostname,
      cardinality: "exactly_one",
    });

    // Never trust the create response's own uuid claim — re-derive it from
    // the real post-save navigation (section 24 applies to creation too,
    // not only updates).
    const match = page.url().match(/\/lead\/([a-f0-9-]{36})/);
    if (!match) throw new Error(`Could not determine the created lead's uuid from the post-save URL: ${page.url()}`);
    return { uuid: match[1], correlation, events: observer.events };
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}

/**
 * Opens the New Lead wizard's Step 1 and clicks Continue with every field
 * left empty — a real, observed check (2026-09-16 exploration, same
 * pattern as contacts-browser.mjs's Person validation) that the two
 * required fields (First Name, Last Name) show Lawcus's own inline
 * validation and that Step 1 never advances to Step 2 (so no lead is
 * created). Never fills anything, never saves.
 */
const REQUIRED_FIELD_MESSAGE = "This field is required and cannot be empty.";

export async function verifyLeadMandatoryFieldValidationViaBrowser({ context }) {
  const page = await context.newPage();
  try {
    await openNewLeadDialog(page);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForTimeout(1000);

    const messageCount = await page.getByText(REQUIRED_FIELD_MESSAGE, { exact: true }).count();
    const stayedOnStep1 = await page.getByText("Add potential client (Step 1/2)", { exact: false }).first().isVisible().catch(() => false);
    const noLeadCreated = !/\/lead\/[a-f0-9-]{36}/.test(page.url());

    return { messageCount, stayedOnStep1, noLeadCreated };
  } finally {
    await page.close().catch(() => {});
  }
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
    if (newValue === "") {
      // Restoring to "unset" — see removeFieldFromForm's comment. A no-op
      // if the field isn't on the form at all (already unset).
      if ((await page.getByText(fieldName, { exact: true }).count()) > 0) {
        await removeFieldFromForm(page, fieldValueInput(page, fieldName));
      }
    } else {
      await ensureFieldOnForm(page, fieldName);
      const valueInput = fieldValueInput(page, fieldName);
      await valueInput.click();
      await valueInput.fill(newValue);
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2500);
    await observer.settle();

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
