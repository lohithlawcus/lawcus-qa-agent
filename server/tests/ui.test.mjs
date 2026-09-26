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
  throw new Error(`${what} did not start.\n${logs.slice(-1500)}`);
}

async function portFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`); return false; } catch { return true; }
}

before(async () => {
  for (const port of [4319, 5173]) assert.ok(await portFree(port), `Port ${port} is in use: stop the running QA service or workspace before test:ui.`);
  scratch = mkdtempSync(join(tmpdir(), "qa-ui-"));
  service = spawn(process.execPath, [join(repo, "server/index.mjs")], { cwd: scratch, env });
  app = spawn(process.execPath, [join(repo, "scripts/run-framework.mjs"), "dev"], { cwd: repo, env });
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
