import { attachNetworkObserver, correlateObservation } from "./network-observer.mjs";
import { attachEvidence } from "./evidence.mjs";
import { STAGING, API_ORIGIN } from "./environment-adapter.mjs";
import { deflateSync, crc32 } from "node:zlib";

/** Hand-generates a small, valid PNG entirely in-process (a few
 * overlapping colored circles) — no external image tool or file needed,
 * so the avatar-upload check stays self-contained and produces a fresh
 * image every run. A deterministic seed keeps a given run reproducible;
 * the caller passes something like Date.now() for real variety. */
function generateAvatarPng(seed) {
  const W = 128, H = 128;
  const palette = [
    [255, 99, 71], [255, 165, 0], [255, 215, 0],
    [60, 179, 113], [30, 144, 255], [147, 112, 219],
  ];
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;

  const circles = [];
  for (let i = 0; i < 6; i++) {
    circles.push({
      cx: (0.15 + rand() * 0.7) * W,
      cy: (0.15 + rand() * 0.7) * H,
      r: (0.15 + rand() * 0.25) * W,
      color: palette[Math.floor(rand() * palette.length)],
    });
  }
  const bg = [245, 247, 250];
  const rowBytes = 1 + W * 3;
  const raw = Buffer.alloc(rowBytes * H);
  for (let y = 0; y < H; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < W; x++) {
      let [r, g, b] = bg;
      let best = -1;
      for (const c of circles) {
        const d = Math.hypot(x - c.cx, y - c.cy);
        if (d <= c.r) {
          const weight = 1 - d / c.r;
          if (weight > best) { best = weight; [r, g, b] = c.color; }
        }
      }
      const px = rowStart + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }
  const compressed = deflateSync(raw, { level: 9 });
  function chunk(tag, data) {
    const tagBuf = Buffer.from(tag, "ascii");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([tagBuf, data])) >>> 0);
    return Buffer.concat([len, tagBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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
  // Real, reproducible flakiness (hit live 2026-09-24, 2 of 3 runs): the
  // fixed-position click above lands before the detail page has finished
  // its own real staging load, so the "Edit Contact" dialog never opens —
  // a timing race against the same documented staging cold-start
  // slowness already worked around elsewhere in this file, not a wrong
  // coordinate (one of those 3 runs succeeded at the identical position).
  // Retrying the whole click-then-wait cycle, not just the wait, mirrors
  // selectContactDropdownOption's own "retry the whole cycle" fix for its
  // own known-flaky click above.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.mouse.click(EDIT_BUTTON_POSITION.x, EDIT_BUTTON_POSITION.y);
    try {
      await page.getByText("Edit Contact", { exact: true }).waitFor({ timeout: 10000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1000);
    }
  }
  if (lastError) throw lastError;
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

/** Removes a custom field from the currently-open edit form via its own
 * (x) control — the real inverse of ensureFieldOnForm's search-to-add, and
 * NOT the same as blanking its text input. Live-verified 2026-09-18 on a
 * real leftover contact: filling '' and clicking Update does not persist
 * as "cleared" in this tenant — the field's last real value stays saved
 * server-side. Un-setting a field (restoring it to how it looked before
 * any test touched it) must go through this control instead. Anchored on
 * the value input's own element, not the field's label text, since a
 * label-text search can resolve to an unrelated same-named node elsewhere
 * in the DOM (hit live while diagnosing this). No-ops if the row can't be
 * found (already removed, or a field with no delete control). */
async function removeFieldFromForm(page, valueInputLocator) {
  const inputHandle = await valueInputLocator.elementHandle();
  if (!inputHandle) return false;
  // Real bug hit live 2026-09-24: finding the delete button via
  // evaluateHandle() and clicking the returned handle in a separate step
  // left a window for a React re-render to detach that exact node between
  // the two round trips ("Element is not attached to the DOM"). Finding
  // and clicking inside one page.evaluate() call closes that window —
  // there's no gap between "found it" and "clicked it" for a re-render to
  // land in.
  return await page.evaluate((input) => {
    let row = input;
    for (let i = 0; i < 6 && row.parentElement; i++) {
      row = row.parentElement;
      const btn = Array.from(row.querySelectorAll("button, [role='button']")).find((b) =>
        b.className.includes("deleteIconBtn"),
      );
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }, inputHandle);
}

/** Opens the New Contact dialog from the Contacts list — shared by every
 * create/validate case below (Person and Company alike). */
async function openNewContactDialog(page) {
  await page.goto(STAGING + "/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator("text=Contacts").first().click();
  await page.waitForTimeout(1500);
  await page.getByText("New Contact", { exact: false }).first().click().catch(async () => {
    await page.getByRole("button", { name: /new/i }).first().click();
    await page.waitForTimeout(500);
    await page.getByText("New Contact", { exact: false }).first().click();
  });
  await page.waitForTimeout(1500);
}

/** Switches the open New Contact dialog to Company type. Person is the
 * dialog's own default, so there's no equivalent selectPerson — nothing
 * to switch away from. Scoped to the dialog: the Contacts LIST page
 * behind it has its own unrelated "Company" filter tab with the exact
 * same visible text, and an unscoped locator resolves to that one
 * instead (real failure hit exploring this live, 2026-09-16).
 */
async function selectCompanyType(page) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByText("Company", { exact: true }).first().click();
  await page.waitForTimeout(500);
}

/**
 * Creates a brand-new standalone Person contact through the real "New
 * Contact" UI (not nested inside a Lead) and returns its real uuid,
 * correlating the resulting network traffic against the approved
 * lawcus.contacts.create contract. Only sets First/Last Name — every
 * default custom field is left at its default (empty) value, matching
 * what the form itself submits unedited.
 */
export async function createContactViaBrowser({ context, apiContracts, firstName, lastName }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    await openNewContactDialog(page);
    await page.locator('input[name="firstName"], input[placeholder*="First"]').first().fill(firstName);
    await page.locator('input[name="lastName"], input[placeholder*="Last"]').first().fill(lastName);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Real observed flakiness (2 of 13 live runs on 2026-09-16, both with
    // durations well inside the normal range — not a slow/timed-out
    // login): a fixed short wait here sometimes sampled the URL while
    // Lawcus was still briefly showing the Contacts list, before its own
    // client-side navigation to the new contact's detail page had landed.
    // Actively wait for the real detail-page URL pattern instead of
    // guessing a fixed delay; .catch() lets a genuine failure still reach
    // the clear error below rather than surfacing waitForURL's own.
    await page.waitForURL(/\/contact\/[a-f0-9-]{36}/, { timeout: 15000 }).catch(() => {});
    // Real race, found live 2026-09-16 (see attachNetworkObserver's own
    // comment): the create response's JSON body is read asynchronously and
    // isn't otherwise awaited anywhere — correlating immediately after the
    // URL wait above can observe responseBody:null for a response that
    // really did have a body.
    await observer.settle();

    const contract = apiContracts.resolveApprovedContract("lawcus.contacts.create");
    const correlation = correlateObservation({
      contract,
      events: observer.events,
      host: new URL(API_ORIGIN).hostname,
      cardinality: "exactly_one",
    });

    // Never trust the create response's own uuid claim — re-derive it from
    // the real post-save navigation (section 24 applies to creation too,
    // not only updates).
    const match = page.url().match(/\/contact\/([a-f0-9-]{36})/);
    if (!match) throw new Error(`Could not determine the created contact's uuid from the post-save URL: ${page.url()}`);
    return { uuid: match[1], correlation, events: observer.events, screenshot: await page.screenshot({ fullPage: false }).catch(() => null) };
  } catch (error) {
    // Attaches evidence to the thrown error via the private WeakMap channel
    // (evidence.mjs — never an own property that a logger could serialize)
    // rather than changing
    // this function into a never-throws contract — every existing caller
    // still gets the same thrown Error it always did, and a caller that
    // knows to look (executeImpactedTest) can read error.screenshot for
    // "why did this fail" without every other caller needing to change.
    attachEvidence(error, { screenshot: await page.screenshot({ fullPage: false }).catch(() => null) });
    throw error;
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}

/**
 * Creates a brand-new standalone Company contact through the real "New
 * Contact" UI, Company type, and returns its real uuid, correlating the
 * resulting network traffic against the approved lawcus.contacts.create
 * contract. Only sets Name — Company's Basic Details has no First/Middle/
 * Last split, just one required "Name" field (real, observed 2026-09-16;
 * see selectCompanyType's comment on why this is a real, separate form,
 * not Person's form with fields hidden).
 */
export async function createCompanyContactViaBrowser({ context, apiContracts, name }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  try {
    await openNewContactDialog(page);
    await selectCompanyType(page);
    await page.locator('input[name="name"]').first().fill(name);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Same real post-save navigation race as Person creation — see
    // createContactViaBrowser's comment above for the evidence.
    await page.waitForURL(/\/contact\/[a-f0-9-]{36}/, { timeout: 15000 }).catch(() => {});
    // Same real response-body race as Person creation — see
    // createContactViaBrowser's comment above; this is in fact the exact
    // call where the race was first caught live (2026-09-16).
    await observer.settle();

    const contract = apiContracts.resolveApprovedContract("lawcus.contacts.create");
    const correlation = correlateObservation({
      contract,
      events: observer.events,
      host: new URL(API_ORIGIN).hostname,
      cardinality: "exactly_one",
    });

    const match = page.url().match(/\/contact\/([a-f0-9-]{36})/);
    if (!match) throw new Error(`Could not determine the created contact's uuid from the post-save URL: ${page.url()}`);
    return { uuid: match[1], correlation, events: observer.events };
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}

function contactDialog(page) {
  return page.locator('[role="dialog"]');
}

/** Clicks a MUI Select-style dropdown by its visible label and picks one
 * option by exact visible text. Scoped to the New Contact dialog so it
 * never resolves to an unrelated same-named column header on the
 * Contacts list table sitting behind the dialog (real collision hit live
 * 2026-09-18 with an unscoped "Prefix" lookup). */
async function selectContactDropdownOption(page, labelText, optionText) {
  const dropdown = contactDialog(page)
    .getByText(labelText, { exact: true })
    .locator("..")
    .locator("..")
    .locator(".MuiSelect-select, [role=\"combobox\"]")
    .first();
  // Real, reproducible flakiness (hit live 2026-09-18 across several
  // separate runs, always on this same click): the option is sometimes
  // rendered but not yet clickable right after opening the menu. Retrying
  // the whole open-menu-then-click cycle, not just the click, has proven
  // reliable — a bare click retry on an already-closed menu does nothing.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dropdown.click();
    await page.waitForTimeout(500);
    try {
      await page.getByRole("option", { name: optionText, exact: true }).click({ timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  throw lastError;
}

/** Fills a plain text field by its visible label, scoped to the dialog —
 * for fields with no stable name attribute (Address's Street/City/State/
 * Zip/Country all render as unnamed MUI inputs). */
async function fillContactFieldByLabel(page, labelText, value) {
  const input = contactDialog(page).getByText(labelText, { exact: true }).locator("xpath=following::input[1]");
  await input.fill(value);
}

/** Opens a dropdown by label and picks whatever its first real option is
 * — used for fields whose valid values aren't known ahead of time (e.g. a
 * firm-specific "Custom Org Users" list). Returns the picked option's
 * text, or null if the dropdown has no options at all. */
async function selectContactFirstDropdownOption(page, labelText) {
  const dropdown = contactDialog(page)
    .getByText(labelText, { exact: true })
    .locator("..")
    .locator("..")
    .locator(".MuiSelect-select, [role=\"combobox\"]")
    .first();
  await dropdown.click();
  await page.waitForTimeout(500);
  const options = page.locator('[role="option"]');
  if ((await options.count()) === 0) {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }
  const text = (await options.first().textContent())?.trim();
  await options.first().click();
  return text;
}

/** Types into a "Type to search..." field and picks its first real
 * result — used for fields that link to an existing real record (an
 * existing Company, Contact, or Matter). Picking the first match is a
 * deliberate, temporary choice (2026-09-18): a genuinely random real
 * record today, until a dedicated set of QA-owned Contacts/Matters exists
 * to pick from instead — see this function's callers for the plan to
 * switch to those once they're identified. Returns the picked record's
 * display text, or null if nothing matched. */
async function pickFirstContactSearchResult(page, searchInput, query = "a") {
  const options = page.locator('[role="option"], li[role="option"]');
  // Real, reproducible race (hit live 2026-09-18, confirmed by direct
  // diagnostic): this autocomplete's underlying record list loads
  // asynchronously after the dialog opens, and typing before it's ready
  // yields zero options even though the exact same query reliably returns
  // real results once it's loaded — a data-readiness race, not a broken
  // interaction. 5 attempts with a generous wait between them absorbs
  // that load time instead of masking a genuine UI defect (there isn't
  // one here: the diagnostic got 50 real results with enough time).
  for (let attempt = 1; attempt <= 5; attempt++) {
    await searchInput.click();
    await searchInput.fill("");
    await searchInput.type(query);
    await page.waitForTimeout(2000);
    if ((await options.count()) > 0) {
      const text = (await options.first().textContent())?.trim();
      await options.first().click();
      await page.waitForTimeout(300);
      return text;
    }
  }
  return null;
}

/**
 * Creates a brand-new standalone Person contact through the real "New
 * Contact" UI with every field across all sections filled — Basic
 * Details, Other Info (including linking a real existing Company and
 * Referred By contact), Addresses, Custom Fields (including linking a
 * real existing Custom Contacts contact and a real existing Custom
 * Matter, and every firm-specific custom field currently configured —
 * this tenant's custom fields have themselves grown between sessions,
 * confirmed live, so unknown/new ones are detected and filled rather than
 * hardcoded), an uploaded avatar image, and a Tag. Independently re-reads
 * the resulting detail page's own text afterward and reports any expected
 * value that doesn't actually appear there — never assumes the form's own
 * state proves what was saved (section 24's discipline).
 *
 * Company/Referred By/Custom Contacts/Custom Matter each link to a real
 * existing record picked as the first search result for a generic query —
 * a genuinely random real record, deliberately, until a dedicated set of
 * QA-owned Contacts/Matters exists to reference by name instead (the
 * user's own direction 2026-09-18: random for now, our own fixtures
 * later).
 *
 * Basic Details/Other Info/Addresses/Company/Referred By/Custom
 * Contacts/most Custom Fields/avatar are live-verified end to end
 * 2026-09-18. Two gaps are known and NOT yet live-verified as of this
 * commit: the Tag picker's real options render as plain chip elements,
 * not `[role="option"]` (this function's current tag-picking locator was
 * written against the wrong assumption and needs a follow-up fix before
 * it can be trusted), and Custom Matter's search-link plus Custom Text's
 * id-anchored fill were each fixed after a live failure but the fix
 * itself hasn't been re-run against real staging yet — do not treat
 * either as confirmed until a fresh `runApprovedTest` on
 * contacts.create_all_fields_verified_on_detail_page comes back
 * status:"passed" with an empty `missing` array.
 */
export async function createContactAllFieldsViaBrowser({ context, apiContracts, marker }) {
  const observer = attachNetworkObserver(context);
  const page = await context.newPage();
  const dialog = contactDialog(page);
  const fields = {
    firstName: marker,
    middleName: "Middleton",
    lastName: "Contact",
    email: `${marker.toLowerCase()}@example.com`,
    // A "555" area code is rejected by real phone validation (see
    // verifyPhoneNumberValidationViaBrowser) — a normal-looking area code
    // is required for this creation check to actually succeed.
    phone: "2025551234",
    title: "QA Test Title",
    website: "https://example.com",
    ledesClientId: "LEDES-TEST-001",
    note: "Created during automated QA field-coverage testing. Safe to delete.",
    street: "123 QA Street",
    city: "Testville",
    state: "TS",
    zip: "00000",
    country: "Testland",
    customNumber: "42",
    customText: "QA custom text value",
    customDate: "01/01/2026",
    customMultiText: "QA multi-line custom text.\nSecond line.",
  };
  const picked = {};
  try {
    await openNewContactDialog(page);

    await dialog.getByText("Basic Details", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await dialog.locator('input[name="prefix"]').fill("Mr.");
    await dialog.locator('input[name="firstName"]').fill(fields.firstName);
    await dialog.locator('input[name="middleName"]').fill(fields.middleName);
    await dialog.locator('input[name="lastName"]').fill(fields.lastName);
    await selectContactDropdownOption(page, "Gender", "Non-binary");
    await dialog.locator('input[name="dateOfBirthday"]').fill("15/06/1990");
    await dialog.locator('input[name="emails.0.value"]').fill(fields.email);
    await dialog.locator('input[type="tel"]').first().fill(fields.phone);

    await dialog.getByText("Other Info", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await dialog.locator('input[name="title"]').fill(fields.title);
    await dialog.locator('input[name="website"]').fill(fields.website);
    // Anchored by position, not by label text: "Company" as an exact-text
    // label also matches the Contact Type radio button of the same name
    // (real collision hit live 2026-09-18), so the reliable anchor here is
    // this section's "Type to search..." placeholder, in real, confirmed
    // DOM order — Company first, then Referred By.
    const otherInfoSearchInputs = dialog.getByPlaceholder("Type to search...");
    picked.company = await pickFirstContactSearchResult(page, otherInfoSearchInputs.nth(0));
    picked.referredBy = await pickFirstContactSearchResult(page, otherInfoSearchInputs.nth(1));
    await selectContactDropdownOption(page, "Lead Source", "Referral");
    await dialog.locator('input[name="ledesClientId"]').fill(fields.ledesClientId);
    await dialog.locator('textarea[name="note"]').fill(fields.note);

    await dialog.getByText("Addresses", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await fillContactFieldByLabel(page, "Street", fields.street);
    await fillContactFieldByLabel(page, "City", fields.city);
    await fillContactFieldByLabel(page, "State/Province", fields.state);
    await fillContactFieldByLabel(page, "Zip/Postal code", fields.zip);
    await fillContactFieldByLabel(page, "Country", fields.country);

    await dialog.getByText("Custom Fields", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await dialog.locator("#custom-component-Custom\\ Number").fill(fields.customNumber);
    // Anchored by this field's own real id, not ".last()" text input on
    // the page (real bug hit live 2026-09-18: as more custom fields exist,
    // the last text input on the page stops being Custom Text
    // specifically) and not a label-relative xpath either (silently
    // filled *something* without erroring, live-confirmed 2026-09-18, but
    // "QA custom text value" never showed up on the saved detail page —
    // same id-anchored pattern already used below for Custom Number/
    // Custom Checkbox/etc, all of which never had this problem). Works
    // whether the field is already on the form (default) or needs adding.
    await ensureFieldOnForm(page, "Custom Text");
    await dialog.locator("#custom-component-Custom\\ Text").fill(fields.customText);
    // These three appeared in this tenant only after the original version
    // of this check was written (confirmed live 2026-09-18: custom field
    // definitions here are edited over time, not fixed) — filled only if
    // actually present, so this check adapts instead of breaking outright
    // if they're renamed or removed later.
    const customDateInput = dialog.getByText("Custom Date", { exact: true }).locator("..").locator('input[placeholder="DD/MM/YYYY"]').first();
    if ((await customDateInput.count()) > 0) await customDateInput.fill(fields.customDate);
    const customMultiTextInput = dialog.getByText("Custom Multi Text", { exact: true }).locator("..").locator("textarea").first();
    if ((await customMultiTextInput.count()) > 0) await customMultiTextInput.fill(fields.customMultiText);
    const customCheckbox = dialog.locator("#custom-component-Custom\\ Checkbox");
    if ((await customCheckbox.count()) > 0) await customCheckbox.check({ force: true });
    if ((await dialog.getByText("Custom Org Users", { exact: true }).count()) > 0) {
      picked.customOrgUser = await selectContactFirstDropdownOption(page, "Custom Org Users");
    }

    await selectContactDropdownOption(page, "Custom Pick List", "Banana");
    // Custom Contacts is the 3rd "Type to search..." input in the dialog
    // overall (Company and Referred By, both in Other Info, are the 1st
    // and 2nd) — same real, confirmed DOM-order anchor as those two.
    const allSearchInputs = dialog.getByPlaceholder("Type to search...");
    picked.customContacts = await pickFirstContactSearchResult(page, allSearchInputs.nth(2));
    const customMatterFieldExists = (await dialog.getByText("Custom Matter", { exact: true }).count()) > 0;
    if (customMatterFieldExists) {
      picked.customMatter = await pickFirstContactSearchResult(page, allSearchInputs.nth(3));
    }
    await dialog.locator("#custom-component-Custom\\ Contact\\ info\\ field").check({ force: true });
    await selectContactDropdownOption(page, "New Contact Picklist", "Wonder");
    await dialog.locator("#custom-component-Custom\\ Contact").check({ force: true });
    await dialog.locator("#custom-component-PHP\\ test\\ checkbox").check({ force: true });

    // Avatar — a freshly generated abstract-art PNG, never a fixed file on
    // disk, so this check needs no external asset and produces a genuinely
    // new image every run.
    await dialog.locator("#avatar_input").setInputFiles({
      name: "qa-avatar.png",
      mimeType: "image/png",
      buffer: generateAvatarPng(Date.now()),
    });
    await page.waitForTimeout(800);

    // Tag — whichever real tag is offered first; this tenant's tag list is
    // itself real, existing configuration, not invented here.
    const tagIcon = dialog.locator("text=Tags").locator("..").locator("svg, button, [role=\"button\"]").first();
    await tagIcon.click();
    await page.waitForTimeout(500);
    const tagChip = page.locator('[role="option"], li[role="option"]').first();
    if ((await tagChip.count()) > 0) {
      picked.tag = (await tagChip.textContent())?.trim();
      await tagChip.click();
    }
    await page.keyboard.press("Escape").catch(() => {});

    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForURL(/\/contact\/[a-f0-9-]{36}/, { timeout: 20000 }).catch(() => {});
    await observer.settle();

    const contract = apiContracts.resolveApprovedContract("lawcus.contacts.create");
    const correlation = correlateObservation({
      contract,
      events: observer.events,
      host: new URL(API_ORIGIN).hostname,
      cardinality: "exactly_one",
    });

    const match = page.url().match(/\/contact\/([a-f0-9-]{36})/);
    if (!match) throw new Error(`Could not determine the created contact's uuid from the post-save URL: ${page.url()}`);

    // Independently re-read the detail page's own rendered text — proof of
    // what was actually saved, not just what the form showed before Save.
    // The expected list is built from what was actually filled/picked at
    // runtime (not hardcoded), since the linked records and this tenant's
    // custom fields are both real and can vary run to run.
    await page.waitForTimeout(1500);
    const detailText = await page.locator("body").innerText();
    const expected = [
      fields.firstName, fields.middleName, fields.lastName, "Non-binary", "15/06/1990",
      fields.email, fields.title, fields.website, "Referral", fields.ledesClientId, fields.note,
      fields.street, fields.city, fields.zip, fields.country, fields.customNumber,
      fields.customText, "Banana", "Wonder",
    ];
    const missing = expected.filter((value) => !detailText.includes(value));

    // Company/Referred By/Custom Contacts/Custom Matter/Tag are required
    // to have actually been picked, not just checked-if-truthy: silently
    // excluding a failed pick from "missing" would let this report
    // "passed" while never actually exercising that field — exactly the
    // fabricated-coverage failure mode this project exists to avoid. A
    // pick that succeeded is still verified against the real detail page.
    for (const [label, value] of [
      ["Company", picked.company],
      ["Referred By", picked.referredBy],
      ["Custom Contacts", picked.customContacts],
      ["Tag", picked.tag],
    ]) {
      if (value == null) missing.push(`${label}: no search result could be picked`);
      else if (!detailText.includes(value)) missing.push(`${label}: picked "${value}" but it doesn't appear on the detail page`);
    }
    // Custom Matter is conditional on the field actually existing — this
    // tenant's custom fields have themselves changed between sessions
    // (confirmed live 2026-09-18), so its absence isn't a failure. But if
    // the field DOES exist, failing to pick a result for it is a real
    // failure, same as the always-required fields above — the field's
    // mere existence, not a truthy check on the pick, decides that.
    if (customMatterFieldExists) {
      if (picked.customMatter == null) missing.push("Custom Matter: no search result could be picked");
      else if (!detailText.includes(picked.customMatter)) missing.push(`Custom Matter: picked "${picked.customMatter}" but it doesn't appear on the detail page`);
    }

    return { uuid: match[1], correlation, events: observer.events, missing, fields, picked };
  } finally {
    observer.dispose();
    await page.close().catch(() => {});
  }
}

/** Fills the required Name fields plus an invalid ("555" area code) phone
 * number and confirms Lawcus's own real phone validation blocks creation
 * — a genuine, live-observed constraint (2026-09-18), not assumed from a
 * generic required-field check. Never fills a real, working phone number;
 * never saves a contact either way. */
const INVALID_PHONE_MESSAGE = "Invalid phone number";

export async function verifyPhoneNumberValidationViaBrowser({ context }) {
  const page = await context.newPage();
  const dialog = contactDialog(page);
  try {
    await openNewContactDialog(page);
    await dialog.locator('input[name="firstName"]').fill("QA Validation");
    await dialog.locator('input[name="lastName"]').fill("Test");
    await dialog.locator('input[type="tel"]').first().fill("5551234567");
    // Move focus off the phone field, same as a real user tabbing away,
    // so the field's own blur-triggered validation actually runs.
    await dialog.locator('input[name="lastName"]').click();
    await page.waitForTimeout(500);
    const invalidMessageShown = (await page.getByText(INVALID_PHONE_MESSAGE, { exact: false }).count()) > 0;
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1000);
    const noContactCreated = !/\/contact\/[a-f0-9-]{36}/.test(page.url());
    return { invalidMessageShown, noContactCreated };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Confirms that turning on "Enable client rates" reveals a genuinely
 * required "Fixed rate" field — attempting Save with it blank is blocked
 * by the same generic required-field message as First/Last Name, then
 * filling it and saving succeeds with the rate shown correctly on the
 * real detail page. A real, cascading-required field discovered live
 * 2026-09-18 — not documented anywhere before this. */
async function enableClientRates(page) {
  const dialog = contactDialog(page);
  await dialog.getByText("Billing Preference", { exact: true }).first().click();
  await page.waitForTimeout(300);
  await dialog
    .getByText("Enable client rates", { exact: false })
    .locator("..")
    .locator('button[role="switch"], input[type="checkbox"]')
    .first()
    .click();
  await page.waitForTimeout(400);
}

export async function verifyBillingRateRequiredValidationViaBrowser({ context }) {
  // Two separate dialogs, not one reused after a failed Save — real issue
  // hit live 2026-09-18: the Save button stays disabled for the entire
  // 35s action timeout after a blocked submission in the same dialog,
  // even once Fixed rate is filled in afterward. A fresh dialog for the
  // "fill it and succeed" half sidesteps whatever stuck state that failed
  // attempt leaves behind, and matches a real user's behavior at least as
  // well as retrying inside the same broken form would.
  const blockedPage = await context.newPage();
  let blockedMessageCount, noContactCreatedWhenBlank, blockedCreatedUuid = null;
  try {
    await openNewContactDialog(blockedPage);
    const dialog = contactDialog(blockedPage);
    await dialog.locator('input[name="firstName"]').fill("QA Validation");
    await dialog.locator('input[name="lastName"]').fill("Test");
    await enableClientRates(blockedPage);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await blockedPage.waitForTimeout(1000);
    blockedMessageCount = await blockedPage.getByText(REQUIRED_FIELD_MESSAGE, { exact: true }).count();
    const blockedMatch = blockedPage.url().match(/\/contact\/([a-f0-9-]{36})/);
    noContactCreatedWhenBlank = !blockedMatch;
    blockedCreatedUuid = blockedMatch?.[1] ?? null;
  } finally {
    await blockedPage.close().catch(() => {});
  }

  const page = await context.newPage();
  try {
    await openNewContactDialog(page);
    const dialog = contactDialog(page);
    await dialog.locator('input[name="firstName"]').fill("QA Validation");
    await dialog.locator('input[name="lastName"]').fill("Test");
    await enableClientRates(page);
    await dialog.locator("#contact_fixed_rate").fill("250");
    await page.waitForTimeout(400);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForURL(/\/contact\/[a-f0-9-]{36}/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const match = page.url().match(/\/contact\/([a-f0-9-]{36})/);
    const detailText = match ? await page.locator("body").innerText() : "";
    const rateShownCorrectly = detailText.includes("250.00");

    return {
      blockedMessageCount,
      noContactCreatedWhenBlank,
      createdAfterFilling: !!match,
      uuid: match?.[1] ?? null,
      blockedCreatedUuid,
      rateShownCorrectly,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Opens the New Contact form and clicks Save with every field left empty —
 * a real, observed check (2026-09-16 exploration) that the two required
 * fields (First Name, Last Name) show Lawcus's own inline validation text
 * and that no contact is actually created. Never fills anything, never
 * saves; closes the drawer without creating a record either way.
 */
const REQUIRED_FIELD_MESSAGE = "This field is required and cannot be empty.";

export async function verifyMandatoryFieldValidationViaBrowser({ context }) {
  const page = await context.newPage();
  try {
    await openNewContactDialog(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1000);

    const messageCount = await page.getByText(REQUIRED_FIELD_MESSAGE, { exact: true }).count();
    // The drawer overlays the Contacts list without changing the URL; a
    // genuinely created contact is the only thing that would put a real
    // contact uuid into it (mirrors createContactViaBrowser's own
    // post-save URL check, used here as proof nothing was created).
    const noContactCreated = !/\/contact\/[a-f0-9-]{36}/.test(page.url());

    return { messageCount, noContactCreated };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Company-type counterpart to verifyMandatoryFieldValidationViaBrowser:
 * Company's Basic Details has exactly one required field (Name, not
 * First/Last), so this checks for exactly one validation message instead
 * of two — a real, observed difference (2026-09-16 exploration), not the
 * Person check reused by assumption. */
export async function verifyMandatoryFieldValidationCompanyViaBrowser({ context }) {
  const page = await context.newPage();
  try {
    await openNewContactDialog(page);
    await selectCompanyType(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1000);

    const messageCount = await page.getByText(REQUIRED_FIELD_MESSAGE, { exact: true }).count();
    const noContactCreated = !/\/contact\/[a-f0-9-]{36}/.test(page.url());

    return { messageCount, noContactCreated };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Locates a custom field's own value input on the Edit Contact form by
 * its real DOM id (id="custom-component-<Field Name>", spaces escaped) —
 * the same id convention confirmed live on the New Contact dialog and
 * used by createContactAllFieldsViaBrowser above. Live-verified 2026-09-24
 * on the Edit form too: a real fix, not an assumption — the Edit form for
 * a contact with several custom fields had 29 text inputs, with "Custom
 * Text" at position 25, three real fields short of ".last()" (the prior
 * approach here), which is why that real bug (real bug hit live
 * 2026-09-23: an impacted-test run reported updateVerified:false for no
 * visible reason) went undetected until this fix — the same class of bug
 * PR #3 already fixed for the New Contact dialog, just never carried over
 * to this separate edit-existing-contact path.
 */
function customFieldValueInput(page, fieldName) {
  return page.locator(`#custom-component-${fieldName.replace(/ /g, "\\ ")}`);
}

/** Opens the contact, reads the named custom field's current value, and
 * closes without saving anything — a real, separate navigation used both
 * to capture before-state and for independent post-update verification
 * (section 24). Also captures a screenshot of this exact moment: this is
 * the read a caller like updateAndRestoreContactCustomFieldViaBrowser
 * compares against to decide pass/fail, so it's the single most useful
 * piece of evidence for "why did this fail." Unlike runLive's login
 * screenshots, nothing here is masked — this page only ever shows the
 * known, QA-owned fixture contact's own fields (never a real customer
 * record), and the whole point of this screenshot is to make the actual
 * field value visible. */
export async function readContactCustomFieldViaBrowser({ context, uuid, fieldName }) {
  const page = await context.newPage();
  try {
    await page.goto(`${STAGING}/contact/${uuid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openEditCustomFields(page);
    await ensureFieldOnForm(page, fieldName);
    const value = await customFieldValueInput(page, fieldName).inputValue();
    const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
    return { value, screenshot };
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
    if (newValue === "") {
      // Restoring to "unset" — see removeFieldFromForm's comment. A no-op
      // if the field isn't on the form at all (already unset).
      if ((await page.getByText(fieldName, { exact: true }).count()) > 0) {
        await removeFieldFromForm(page, customFieldValueInput(page, fieldName));
      }
    } else {
      await ensureFieldOnForm(page, fieldName);
      const valueInput = customFieldValueInput(page, fieldName);
      await valueInput.click();
      await valueInput.fill(newValue);
    }
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.waitForTimeout(2500);
    await observer.settle();

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

  const before = await readContactCustomFieldViaBrowser({ context, uuid, fieldName });
  const beforeValue = before.value;
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
  const afterUpdateRead = await readContactCustomFieldViaBrowser({ context, uuid, fieldName });
  const afterUpdate = afterUpdateRead.value;
  const updateVerified = afterUpdate === newValue;

  const { correlation: restoreCorrelation } = await updateContactCustomFieldViaBrowser({
    context, apiContracts, uuid, fieldName, newValue: beforeValue,
  });
  const afterRestoreRead = await readContactCustomFieldViaBrowser({ context, uuid, fieldName });
  const afterRestore = afterRestoreRead.value;
  const restored = afterRestore === beforeValue;

  mutationJournal.recordRestoration(journalEntry.id, {
    status: restored ? "restored" : "conflict",
    note: restored ? null : `Expected "${beforeValue}", found "${afterRestore}" after restoration.`,
  });

  // The most diagnostically useful screenshot for "why did this fail":
  // the read that actually decided pass/fail. If the update itself wasn't
  // verified, that's the read that matters; otherwise the restore read is
  // both the more recent and (if it also failed) the more relevant one.
  const screenshot = !updateVerified ? afterUpdateRead.screenshot : afterRestoreRead.screenshot;

  return {
    beforeValue,
    updateCorrelation: correlation,
    updateVerified,
    afterUpdate,
    restoreCorrelation,
    restored,
    afterRestore,
    screenshot,
    journalEntry,
  };
}
