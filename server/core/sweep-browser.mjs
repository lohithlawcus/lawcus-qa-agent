import { STAGING } from "./environment-adapter.mjs";
import { isQaNamed } from "./sweep-names.mjs";

// The browser half of a sweep. It only LOADS the tenant's own list pages and
// pages through them with the grid's own "next page" control, reading the list
// responses the app itself asks for. It never types into a search box (the
// global search saves recent searches to the account's settings, which is a
// write), never clicks anything but the pager, and the context it runs in
// refuses every non-list write (see permitSweepRequest in live-runner.mjs).
//
// Each list is sorted newest first, so it stops as soon as a page reaches
// records older than the cutoff. Only records that carry this tool's own naming
// are kept; the rest of the tenant's records are counted, then dropped.

const LISTS = {
  contact: { path: "/contacts", endpoint: "/v2/contacts", maxPages: 60, dateField: "created_at" },
  matter: { path: "/matters", endpoint: "/v2/matters", maxPages: 30, dateField: "created_at" },
  lead: { path: "/leads", endpoint: "/v2/leads", maxPages: 1, dateField: "lead_created_at" },
};

/** "2026-09-15T00:00:00.000Z" -> "2026-09-15 00:00:00", the tenant's own format. */
export const tenantTimestamp = (iso) => new Date(iso).toISOString().replace("T", " ").slice(0, 19);

async function readOneList(context, spec, cutoffText) {
  const page = await context.newPage();
  const records = [];
  let scanned = 0;
  let pagesRead = 0;
  let totalInTenant = null;
  let truncated = false;
  // A response for this list at this offset. Registered BEFORE the action that
  // causes it, so a fast answer is never missed.
  const listResponse = (skip) =>
    page.waitForResponse(
      (response) => {
        const request = response.request();
        if (request.method() !== "POST" || new URL(response.url()).pathname !== spec.endpoint) return false;
        try {
          return request.postDataJSON()?.pagination?.skip === skip;
        } catch {
          return false;
        }
      },
      { timeout: 30000 },
    );
  try {
    let waiting = listResponse(0);
    await page.goto(STAGING + spec.path, { waitUntil: "domcontentloaded" });
    let response = await waiting;
    for (;;) {
      const body = await response.json();
      const take = response.request().postDataJSON()?.pagination?.take ?? 0;
      const list = Array.isArray(body.list) ? body.list : [];
      pagesRead += 1;
      if (typeof body.total === "number") totalInTenant = body.total;
      let oldest = null;
      for (const item of list) {
        scanned += 1;
        const created = item?.[spec.dateField] ?? null;
        if (created && (oldest === null || created < oldest)) oldest = created;
        // Keep only this tool's own naming, and only from the cutoff on.
        if (item?.uuid && isQaNamed(item.name) && (!created || created >= cutoffText)) {
          records.push({ id: item.uuid, name: item.name, createdAt: created });
        }
      }
      if (list.length < take) break; // the last page
      if (oldest !== null && oldest < cutoffText) break; // reached the cutoff
      if (pagesRead >= spec.maxPages) {
        truncated = true;
        break;
      }
      const next = page.locator('[aria-label="Go to next page"]').first();
      if (!(await next.count()) || !(await next.isEnabled())) break;
      waiting = listResponse(pagesRead * take);
      await next.click();
      response = await waiting;
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { records, scanned, pagesRead, truncated, totalInTenant };
}

/** Reads the contacts, matters and leads lists back to `cutoff` (an ISO time). */
export async function readTenantLists({ context, cutoff }) {
  const cutoffText = tenantTimestamp(cutoff);
  const result = {};
  for (const [kind, spec] of Object.entries(LISTS)) result[kind] = await readOneList(context, spec, cutoffText);
  return result;
}
