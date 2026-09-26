import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { runPreflight, preflightMessage } from "../core/preflight.mjs";
import { describeLoginStall, assertIdentity } from "../core/live-runner.mjs";
import { runApprovedTest, McpToolError, MCP_ERROR } from "../mcp/tools.mjs";
import { classifyThrown } from "../core/failure-class.mjs";

// Nothing here may read the real Keychain, resolve a real host or launch a browser.
process.env.QA_FORBID_LIVE = "1";

const dir = () => mkdtempSync(join(tmpdir(), "qa-preflight-"));
const good = (dirPath) => ({
  artifactDirectory: dirPath,
  probes: { evidenceKeyExists: async () => true, chromiumPath: async () => join(dirPath, "chrome"), resolveHost: async () => "203.0.113.1" },
});

test("passes when the key, folder, browser and tenant DNS are all fine", async () => {
  const d = dir();
  try {
    writeFileSync(join(d, "chrome"), "x");
    const r = await runPreflight(good(d));
    assert.equal(r.ok, true);
    assert.deepEqual(r.failed, []);
    assert.ok(r.checks.length >= 4);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

for (const [name, probes, expected] of [
  ["a missing evidence key", { evidenceKeyExists: async () => false }, /Evidence key/],
  ["a browser that is not installed", { chromiumPath: async () => "/no/such/chrome" }, /Chromium/],
  ["a tenant host that does not resolve", { resolveHost: async () => { throw new Error("ENOTFOUND"); } }, /resolves/],
  ["a probe that throws", { evidenceKeyExists: async () => { throw new Error("keychain locked"); } }, /keychain locked/],
]) {
  test(`refuses on ${name}, and says what to fix`, async () => {
    const d = dir();
    try {
      writeFileSync(join(d, "chrome"), "x");
      const base = good(d);
      const r = await runPreflight({ ...base, probes: { ...base.probes, ...probes } });
      assert.equal(r.ok, false);
      assert.match(r.failed.join(" "), expected);
      assert.match(preflightMessage(r), /no staging sign-in was used/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}

test("refuses when the evidence folder cannot be written", async () => {
  const d = dir();
  try {
    writeFileSync(join(d, "chrome"), "x");
    const locked = join(d, "locked");
    await runPreflight({ ...good(d), artifactDirectory: locked }); // creates it
    chmodSync(locked, 0o500);
    const r = await runPreflight({ ...good(d), artifactDirectory: locked });
    if (process.getuid?.() === 0) return; // root ignores permissions
    assert.equal(r.ok, false);
    assert.match(r.failed.join(" "), /Evidence folder/);
    chmodSync(locked, 0o700);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("with QA_FORBID_LIVE the real probes fail closed instead of touching the Keychain", async () => {
  const d = dir();
  try {
    const r = await runPreflight({ artifactDirectory: d, hosts: [] });
    assert.equal(r.checks.find((c) => c.id === "evidence_key").ok, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- sign-in stall diagnostic ----------

test("a stalled sign-in says how long it waited and whether it left the login page, path only", () => {
  assert.match(describeLoginStall({ url: () => "https://lohith.fiveriverz.com/login?token=SECRET" }, 34500), /35s, still on the login page/);
  const away = describeLoginStall({ url: () => "https://lohith.fiveriverz.com/dashboard?x=SECRET" }, 12000);
  assert.match(away, /12s, on \/dashboard/);
  assert.doesNotMatch(away + describeLoginStall({ url: () => "https://h/login?token=SECRET" }, 1), /SECRET/);
  assert.match(describeLoginStall({ url: () => { throw new Error("closed"); } }, 1000), /unknown page/);
});

test("the added diagnostic does not change how the failure is classified", () => {
  const original = "locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByPlaceholder('Search your practice')";
  const before = classifyThrown(new Error(original));
  const after = classifyThrown(new Error(original + describeLoginStall({ url: () => "https://h/login" }, 35000)));
  assert.equal(after.failureClass, before.failureClass);
  assert.equal(after.reasonCode, before.reasonCode);
  assert.equal(after.reasonCode, "login_timeout");
});

test("assertIdentity keeps the original timeout text and adds where the sign-in stalled", async () => {
  const original = "locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByPlaceholder('Search your practice')";
  const page = { url: () => "https://lohith.fiveriverz.com/login", getByPlaceholder: () => ({ waitFor: async () => { throw new Error(original); } }) };
  await assert.rejects(assertIdentity(page, "qa@example.test"), (e) => e.message.startsWith(original) && /still on the login page/.test(e.message) && classifyThrown(e).reasonCode === "login_timeout");
});

// ---------- the MCP gate ----------

test("an MCP run is refused before any run row exists when preflight fails, and gets past the gate when it passes", async () => {
  const d = dir();
  try {
    const { db, audit } = openStore(d);
    const testbook = openTestBook(db, audit);
    const status = "approved";
    testbook.syncCases({
      featureName: "Contacts", featureDescription: "d", suiteName: "contact-verification", suiteDescription: "d",
      entries: {
      "contacts.custom_field_update_existing": { source: JSON.stringify({ kind: "native", module: "m", function: "runContactCustomFieldCheck" }), definition: { id: "contacts.custom_field_update_existing", name: "Update existing", layer: "both", risk: "normal", status } },
      },
    });
    const ctx = { db, testbook, apiContracts: openApiContracts(db, audit), mutationJournal: openMutationJournal(db, audit) };
    const runs = () => db.prepare("SELECT COUNT(*) n FROM runs").get().n;
    const id = "contacts.custom_field_update_existing";
    await assert.rejects(
      runApprovedTest({ ...ctx, preflight: async () => ({ ok: false, failed: ["Evidence key is in the Keychain (missing)"] }) }, { externalId: id }),
      (e) => e instanceof McpToolError && e.code === MCP_ERROR.NOT_RUNNABLE && /no staging sign-in was used/.test(e.message),
    );
    assert.equal(runs(), 0);
    // A passing preflight lets the run start; the real runner is then forbidden by QA_FORBID_LIVE, so it fails inside.
    let asked = 0;
    await runApprovedTest({ ...ctx, preflight: async () => { asked += 1; return { ok: true, checks: [], failed: [] }; } }, { externalId: id }).catch(() => {});
    assert.equal(asked, 1);
    assert.equal(runs(), 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
