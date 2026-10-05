// Drives the real workspace in Chromium against a throwaway backend (empty data
// folder, QA_FORBID_LIVE set), so it never reads the Keychain or reaches
// staging. Run by `npm run test:ui`, not by `npm test`: it needs Chromium and
// the two fixed local ports (4319 for the service, 5173 for the workspace).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repo = resolve(import.meta.dirname, "../..");
const APP = "http://127.0.0.1:5173";
const env = { ...process.env, QA_FORBID_LIVE: "1" };
let scratch, service, app, browser, page, logs = "";

async function waitFor(url, what, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not start.\n${logs.slice(-3000)}`);
}

async function portFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`); return false; } catch { return true; }
}

before(async () => {
  for (const port of [4319, 5173]) assert.ok(await portFree(port), `Port ${port} is in use: stop the running QA service or workspace before test:ui.`);
  scratch = mkdtempSync(join(tmpdir(), "qa-ui-"));
  service = spawn(process.execPath, [join(repo, "server/index.mjs")], { cwd: scratch, env });
  // vinext 1.0.1 fully delegates to vite's own CLI, which renamed --hostname
  // to --host (2026-10-04, surfaced by the dependency-security-fixes PR's
  // npm audit fix bumping vinext within its existing ^1.0.0-beta.9 range).
  app = spawn(process.execPath, [join(repo, "scripts/run-framework.mjs"), "dev", "--host", "127.0.0.1"], { cwd: repo, env });
  for (const child of [service, app]) for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => { logs += d; });
  await waitFor("http://127.0.0.1:4319/session", "The service");
  await waitFor(APP + "/", "The workspace");
  browser = await chromium.launch({ chromiumSandbox: true });
  page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await page.goto(APP + "/", { waitUntil: "domcontentloaded" });
});

after(async () => {
  await browser?.close().catch(() => {});
  for (const child of [service, app]) child?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// A failing UI test is only useful if it says what the screen showed.
const ui = (name, fn) =>
  test(name, async () => {
    try { await fn(); }
    catch (error) {
      const shown = await page.locator("body").innerText().catch(() => "(page unreadable)");
      console.error(`--- ${name}: visible page text ---\n${shown.slice(shown.indexOf("YOUR QA WORKSPACE"), shown.indexOf("YOUR QA WORKSPACE") + 1800)}`);
      throw error;
    }
  });

// The workspace must have hydrated before a click does anything, so keep clicking until the tab is selected.
async function tab(name) {
  const target = page.getByRole("tab", { name: new RegExp(`^${name}`) });
  await page.getByText("Local runner connected").first().waitFor();
  for (let attempt = 0; attempt < 10; attempt++) {
    await target.click();
    if ((await target.getAttribute("aria-selected")) === "true") return;
    await page.waitForTimeout(500);
  }
  assert.fail(`Could not open the ${name} tab.`);
}

ui("a bad import is refused whole, with the line named", async () => {
  await tab("Knowledge");
  await page.locator("textarea").first().fill("this is not a rule");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Nothing was imported" });
  await alert.waitFor();
  assert.match(await alert.innerText(), /Line \d+:|fix these/);
});

ui("the example import proposes facts that wait for review", async () => {
  await tab("Knowledge");
  await page.getByRole("button", { name: "Load example" }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const status = page.getByRole("status").filter({ hasText: /Proposed \d+ Knowledge item/ });
  await status.waitFor();
  assert.match(await status.innerText(), /Proposed 1 Knowledge item and 1 relationship/);
});

ui("approving a pending fact says it is now trusted", async () => {
  await tab("Knowledge");
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await page.getByText(/Knowledge approved\. It now appears as trusted/).waitFor();
});

ui("a product change is recorded and shows in the list", async () => {
  await tab("Facts & changes");
  await page.getByRole("tab", { name: /Product changes/ }).click();
  await page.getByLabel("Title").fill("Contact email is now required");
  await page.getByLabel("What changed").fill("Release note: the Contact email field became mandatory.");
  await page.getByRole("button", { name: "Record and analyze" }).click();
  await page.getByRole("heading", { name: "Contact email is now required" }).first().waitFor();
});

ui("Safety & coverage lists every check with why it does or does not count", async () => {
  await tab("Safety & coverage");
  await page.getByRole("heading", { name: "What counts as coverage today" }).waitFor();
  // A fresh backend has run nothing, so no approved check can count yet.
  await page.getByText(/^0 of \d+ checks count as coverage/).waitFor();
  await page.getByText("Never run on staging").first().waitFor();
});

ui("the Facts view lists facts with their state and opens one with its evidence", async () => {
  await tab("Facts & changes");
  await page.getByRole("tab", { name: "Facts", exact: true }).click();
  await page.getByRole("heading", { name: "Facts", exact: true }).waitFor();
  const all = page.getByRole("group", { name: "Filter facts by state" }).getByRole("button", { name: /^All \(\d+\)/ });
  await all.waitFor();
  const row = page.locator("button.fact-row").first();
  const title = (await row.locator("h3").innerText()).trim();
  await row.click();
  await page.getByRole("heading", { name: title, exact: true, level: 2 }).waitFor(); // the card, not the row
  // The card must say where the fact comes from and what it is; a fact card with neither is useless.
  const card = await page.locator("main").innerText();
  assert.match(card, /source/i);
  assert.match(card, /pending|approved|superseded|rejected/i);
});

ui("approving an API contract says it is now trusted", async () => {
  await tab("API Contracts");
  await page.getByText("API CONTRACT INBOX").waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await page.getByText(/Approved\. It is now part of the trusted/).waitFor();
});

ui("Personas: an unlabelled persona is refused, and a registered one waits for a visible sign-in", async () => {
  await tab("Personas");
  await page.getByText("No personas registered yet").waitFor();
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await page.getByText("Give this persona a label.").waitFor();
  await page.getByPlaceholder(/^Label, e\.g\./).fill("QA Admin");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await page.getByText("Persona registered. It stays unusable until verified by visible sign-in.").waitFor();
  await page.getByText("QA Admin", { exact: true }).waitFor();
  // Registering must not claim it can be used: it stays unverified until a person signs in.
  assert.equal(await page.getByText(/session: /).count(), 0);
  assert.equal(await page.getByText("No personas registered yet").count(), 0);
});

ui("Teach / Record: an empty description is refused, and no recording starts when the browser cannot open", async () => {
  await tab("Teach / Record");
  await page.getByText("No recordings yet").waitFor();
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByText("Describe the feature and the workflow you'll perform.").waitFor();
  await page.getByPlaceholder(/^Feature, e\.g\./).fill("Contacts");
  await page.getByPlaceholder(/^Describe the workflow/).fill("Edit a contact's custom field and save");
  await page.getByRole("button", { name: "Start recording" }).click();
  // QA_FORBID_LIVE stops the browser from launching, so the screen must say so and must not pretend to record.
  await page.getByText(/Live access \(.*\) is forbidden in this process/).first().waitFor();
  assert.equal(await page.getByText("RECORDING IN PROGRESS").count(), 0);
});

ui("Run history shows the staging deletions panel, empty on a fresh backend", async () => {
  await tab("Run history");
  await page.getByRole("heading", { name: "Records the tool created" }).waitFor();
  await page.getByText("No records are waiting for a deletion decision.").waitFor();
  const panel = await page.getByRole("heading", { name: "Records the tool created" }).locator("xpath=ancestor::div[contains(@class,'panel')][last()]").innerText();
  assert.match(panel, /nothing is deleted from Lawcus until a deletion run is started/);
});

ui("Sweep now refuses cleanly when the environment is not set up, and records nothing", async () => {
  await tab("Environment");
  await page.getByRole("button", { name: "Sweep now" }).click();
  // Scoped to the sweep panel: other panels on this tab show their own alerts.
  const panel = page.getByRole("heading", { name: "Staging sweep" }).locator("xpath=ancestor::div[contains(@class,'panel')][last()]");
  const alert = panel.getByRole("alert").filter({ hasText: /browser connection|staging account|no staging sign-in was used/ });
  await alert.waitFor();
  const res = await page.evaluate(async () => {
    const r = await fetch("http://127.0.0.1:4319/sweeps", { credentials: "include", headers: { "X-QA-Client": "lawcus-workspace" } });
    return r.json();
  });
  assert.ok(Array.isArray(res.sweeps));
  assert.equal(res.sweeps.length, 0);
});
