import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { seedLawcusNativeCases, CONTACTS_NATIVE_CASES, LEADS_NATIVE_CASES } from "../testbook/lawcus-native-cases.mjs";

function withTestBook(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-native-cases-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openTestBook(db, audit));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("seedLawcusNativeCases registers every real Step 15 primitive as an approved TestBook case, idempotently", () => {
  withTestBook((testbook) => {
    seedLawcusNativeCases(testbook);
    seedLawcusNativeCases(testbook); // idempotency

    const tree = testbook.tree();
    const contacts = tree.find((f) => f.name === "Contacts");
    const leads = tree.find((f) => f.name === "Leads");
    assert.ok(contacts, "Contacts feature should exist");
    assert.ok(leads, "Leads feature should exist");

    const contactCases = contacts.suites.flatMap((s) => s.cases);
    const leadCases = leads.suites.flatMap((s) => s.cases);
    assert.equal(contactCases.length, Object.keys(CONTACTS_NATIVE_CASES).length);
    assert.equal(leadCases.length, Object.keys(LEADS_NATIVE_CASES).length);
    assert.ok(contactCases.every((c) => c.status === "approved"));
    assert.ok(leadCases.every((c) => c.status === "approved"));
    assert.ok(contactCases.every((c) => c.currentVersion === 1)); // no duplicate version from the second sync call
  });
});

test("every native case's source is a real, honest JSON descriptor naming a function that actually exists in live-runner.mjs", async () => {
  const liveRunner = await import("../core/live-runner.mjs");
  for (const [externalId, { source }] of [
    ...Object.entries(CONTACTS_NATIVE_CASES),
    ...Object.entries(LEADS_NATIVE_CASES),
  ]) {
    const parsed = JSON.parse(source);
    assert.equal(parsed.kind, "native");
    assert.equal(typeof liveRunner[parsed.function], "function", `${externalId} cites a real exported function`);
  }
});
