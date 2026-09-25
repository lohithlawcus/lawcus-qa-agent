import { attachNetworkObserver, correlateObservation } from "./network-observer.mjs";
import { attachEvidence, captureScreenshot } from "./evidence.mjs";
import { STAGING, API_ORIGIN } from "./environment-adapter.mjs";

// The Contact -> Matter slice. Both flows drive the real "New Matter" dialog
// (observed live on Fiveriverz, 2026-09-26). What that dialog does:
//  - Client* is a "Type to search..." picker (POST /search/contacts); Matter
//    Name* is a plain input (name="name"); Pipeline* and Stage* arrive
//    pre-filled ("Default" / "Case Assessment"). Everything else is optional.
//  - Create issues POST /matters and Lawcus navigates to /matter/<uuid>.
//  - The detail page first shows "Client Name: —" and only fills the client in
//    once GET /matters/<uuid> has returned, so a check must WAIT for the client
//    (a fixed short delay reads the placeholder and fails a correct matter).
//  - The Client picker's dropdown shares the page with the rich-text editor's
//    font list (role=option elements too), so options are matched by the
//    contact's own text, never by position.

const MATTER_URL = /\/matter\/([a-f0-9-]{36})/;
const REQUIRED_MESSAGE = "This field is required and cannot be empty.";

async function openNewMatterDialog(page) {
  await page.goto(`${STAGING}/matters`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New Matter" }).first().click();
  // A CSS locator, not getByRole("dialog"): while the Client picker's popup is
  // open the dialog drops out of the accessibility tree, and a role-based
  // locator then finds nothing (seen live 2026-09-26).
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.getByPlaceholder("Type to search...").first().waitFor({ state: "visible" });
  return dialog;
}

/** Types into the Client picker and clicks the option for `contact`.
 *
 * Two hazards, both seen live on 2026-09-26:
 *  - The dropdown ALWAYS ends with an `Add "<typed text>"` row that opens an
 *    "Add a Contact" dialog. It contains the typed text, so a text match on the
 *    search term alone can click it. The row for the contact is matched by the
 *    contact's full name, and any row starting with `Add "` is excluded.
 *  - A just-created contact is not searchable straight away; until it is, the
 *    dropdown offers only the Add row. So retype after a pause, and if the
 *    contact never appears fail with that explanation rather than clicking
 *    anything else. */
export async function pickClient(page, dialog, contact) {
  const input = dialog.getByPlaceholder("Type to search...").first();
  const option = page
    .locator('li[role="option"]')
    .filter({ hasText: contact.displayName })
    .filter({ hasNotText: /^\s*Add "/ })
    .first();
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await input.click();
    await input.fill("");
    await input.pressSequentially(contact.searchText, { delay: 40 });
    try {
      await option.waitFor({ state: "visible", timeout: 8000 });
      await option.click();
      return;
    } catch {
      if (attempt < attempts) await page.waitForTimeout(5000);
    }
  }
  throw new Error(
    `The Client picker never offered "${contact.displayName}" after ${attempts} tries (about ${attempts * 13} seconds). The contact may not be searchable yet; nothing was selected.`,
  );
}

/**
 * Creates a Matter for an existing Person contact through the real New Matter
 * dialog, then proves the link from both sides: the network (GET
 * /matters/<uuid> lists the contact) and the page (the header shows the
 * client's name once loaded).
 *
 * `contact` is { uuid, searchText, displayName } — searchText is what to type
 * into the picker (the contact's unique last name), displayName is how the
 * detail page prints the client (the contact's full name). `onCreated` is
 * called the moment the matter's uuid is known, so a caller can record
 * ownership even if a later step throws.
 */
export async function createMatterForContactViaBrowser({ context, apiContracts, contact, matterName, onCreated = null }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    const dialog = await openNewMatterDialog(page);
    await pickClient(page, dialog, contact);
    await dialog.locator('input[name="name"]').fill(matterName);
    await dialog.locator("button").filter({ hasText: /^Create$/ }).click();
    await page.waitForURL(MATTER_URL, { timeout: 20000 }).catch(() => {});
    await observer.settle();

    const contract = apiContracts.resolveApprovedContract("lawcus.matters.create");
    const correlation = correlateObservation({
      contract,
      events: observer.events,
      host: new URL(API_ORIGIN).hostname,
      cardinality: "exactly_one",
    });

    // Never trust the create response's own uuid: re-derive it from the real
    // post-save navigation.
    const match = page.url().match(MATTER_URL);
    if (!match) throw new Error(`Could not determine the created matter's uuid from the post-save URL: ${new URL(page.url()).pathname}`);
    const uuid = match[1];
    onCreated?.(uuid);

    // Independent re-read: the matter Lawcus returns for that uuid must list
    // the contact we chose. Wait for the detail page to have loaded it.
    const reread = () =>
      observer.events.find(
        (event) => event.method === "GET" && new URL(event.url).pathname === `/matters/${uuid}` && event.status === 200 && event.responseBody,
      );
    for (let i = 0; i < 30 && !reread(); i++) await page.waitForTimeout(500);
    await observer.settle();
    const body = reread()?.responseBody;
    const linkedContacts = Array.isArray(body?.contacts) ? body.contacts.map((c) => c.uuid) : [];
    const clientLinked = linkedContacts.includes(contact.uuid) && String(body?.client_id ?? "") !== "";
    // The page-level proof: wait for the header to replace its "—" placeholder.
    const clientShownOnPage = await page
      .waitForFunction((name) => document.body.innerText.includes(`Client Name:\n${name}`), contact.displayName, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    return { uuid, matterName, correlation, clientLinked, clientShownOnPage, linkedContactCount: linkedContacts.length, events: observer.events, screenshot: await captureScreenshot(page) };
  } catch (error) {
    attachEvidence(error, { screenshot: await captureScreenshot(page) });
    throw error;
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}

/**
 * Submits the New Matter dialog empty and confirms Lawcus's own validation:
 * Client and Matter Name are both flagged, no create request is sent, and the
 * dialog stays open. Creates nothing.
 */
export async function verifyMatterMandatoryFieldValidationViaBrowser({ context }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    const dialog = await openNewMatterDialog(page);
    await dialog.locator("button").filter({ hasText: /^Create$/ }).click();
    await page.getByText(REQUIRED_MESSAGE).first().waitFor({ state: "visible", timeout: 10000 });
    await observer.settle();
    const messageCount = await page.getByText(REQUIRED_MESSAGE).count();
    const dialogStillOpen = await dialog.isVisible();
    const noMatterCreated = !observer.events.some(
      (event) => event.method === "POST" && new URL(event.url).pathname === "/matters",
    );
    return { messageCount, dialogStillOpen, noMatterCreated, stayedOnList: !MATTER_URL.test(page.url()), screenshot: await captureScreenshot(page) };
  } catch (error) {
    attachEvidence(error, { screenshot: await captureScreenshot(page) });
    throw error;
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}
