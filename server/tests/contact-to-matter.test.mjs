import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openMutationJournal } from "../core/mutation-journal.mjs";
import { openResourceOwnership } from "../core/resource-ownership.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { seedLawcusApiContracts } from "../api-contracts/lawcus-seed.mjs";
import { correlateObservation } from "../core/network-observer.mjs";
import { planImpactedTest } from "../core/impacted-testing.mjs";
import { permitMattersRequest } from "../core/live-runner.mjs";
import { pickClient } from "../core/matters-browser.mjs";
import { buildNativeRunners, seedLawcusNativeCases, PROTECTED_RESOURCE_IDS, NATIVE_QUARANTINE } from "../testbook/lawcus-native-cases.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-matter-"));
  try {
    const { db, audit } = openStore(dir);
    const apiContracts = openApiContracts(db, audit);
    seedLawcusApiContracts(apiContracts);
    return fn({
      db, audit, apiContracts,
      resourceOwnership: openResourceOwnership(db, audit, { protectedResourceIds: PROTECTED_RESOURCE_IDS }),
      mutationJournal: openMutationJournal(db, audit),
      testbook: openTestBook(db, audit),
      knowledge: openKnowledge(db, audit),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ scenarios: [] }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, "passed", 0, new Date().toISOString());
  return runId;
}

// The request Lawcus really sent when a Matter was created for a QA contact
// (captured live 2026-09-26); the response keeps the fields that matter.
const REAL_REQUEST = {
  name: "QA Matter 1790361709659", open_date: "2026-09-25 18:42:28", workflow_id: 6386, client_id: 692685, stage_id: 19230,
  custom_fields: [{ team_custom_field_id: 21, value: "" }, { team_custom_field_id: 22, value: "" }],
  assign_id: ["11446f30-fe47-11ef-a44a-6327492a773c"], billing_type: "HOURLY", rate: null, originating_timekeeper_id: 3918,
  responsible_attorney_id: 3918, location_id: null, override_client_rates: false, position: 7, rates: null, estimated_cost: null,
};
const REAL_RESPONSE = { id: 70123, uuid: "e00e63a0-b910-11f1-9233-8f4d656309bc", name: "QA Matter 1790361709659", status: "OPEN", stage_id: 19230, color_code: null, tags: [] };
const event = (over = {}) => ({ method: "POST", url: "https://api.fiveriverz.com/matters", status: 200, requestBody: REAL_REQUEST, responseBody: REAL_RESPONSE, ...over });

function approvedMatterContract(apiContracts) {
  const pending = apiContracts.inbox().find((c) => c.semantic_id === "lawcus.matters.create");
  assert.ok(pending, "the contract is proposed by the seed");
  apiContracts.approveContract(pending.id, "operator:tester", "test");
  return apiContracts.resolveApprovedContract("lawcus.matters.create");
}
const correlate = (contract, events) => correlateObservation({ contract, events, host: "api.fiveriverz.com", cardinality: "exactly_one" });

// ---------- the contract ----------

test("lawcus.matters.create is only PROPOSED by the seed: the runner cannot use it until a human approves it", () => {
  withApp(({ apiContracts }) => {
    assert.throws(() => apiContracts.resolveApprovedContract("lawcus.matters.create"));
    assert.ok(apiContracts.inbox().some((c) => c.semantic_id === "lawcus.matters.create"));
  });
});

test("the contract accepts the real captured Matter create and rejects drift", () => {
  withApp(({ apiContracts }) => {
    const contract = approvedMatterContract(apiContracts);
    assert.equal(correlate(contract, [event()]).contractMatch, true);
    // A field that is ABSENT (not present-but-undefined), so only the `required` list can catch it.
    const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
    const drift = [
      ["no client_id", event({ requestBody: without(REAL_REQUEST, "client_id") })],
      ["client_id as a string", event({ requestBody: { ...REAL_REQUEST, client_id: "692685" } })],
      ["no name", event({ requestBody: without(REAL_REQUEST, "name") })],
      ["no stage_id", event({ requestBody: without(REAL_REQUEST, "stage_id") })],
      ["response without uuid", event({ responseBody: without(REAL_RESPONSE, "uuid") })],
      ["response without status", event({ responseBody: without(REAL_RESPONSE, "status") })],
      ["response uuid not a string", event({ responseBody: { ...REAL_RESPONSE, uuid: 5 } })],
      ["unexpected status", event({ status: 500 })],
    ];
    for (const [label, e] of drift) assert.equal(correlate(contract, [e]).contractMatch, false, label);
    assert.equal(correlate(contract, []).cardinalityOk, false, "no request at all is not a pass");
    assert.equal(correlate(contract, [event(), event()]).cardinalityOk, false, "two creates are not exactly one");
  });
});

// ---------- the write policy ----------

test("the Matter write policy adds exactly POST /matters to the Contacts policy — nothing else, and never a settings write", () => {
  const api = "https://api.fiveriverz.com";
  const allowed = [
    ["POST", `${api}/matters`], ["POST", `${api}/contacts`], ["GET", `${api}/matters/e00e63a0-b910-11f1-9233-8f4d656309bc`],
    ["POST", `${api}/v2/matters`],
  ];
  for (const [method, url] of allowed) assert.equal(permitMattersRequest(url, method, "fetch", null), true, `${method} ${url}`);
  assert.equal(permitMattersRequest(`${api}/search/contacts`, "POST", "fetch", JSON.stringify({ params: { terms: "x" }, pagination: { skip: 0, take: 10 } })), true);
  const refused = [
    ["PUT", `${api}/settings/user`], ["POST", `${api}/matters/e00e63a0-b910-11f1-9233-8f4d656309bc`], ["PUT", `${api}/matters`],
    ["DELETE", `${api}/matters/e00e63a0-b910-11f1-9233-8f4d656309bc`], ["POST", `${api}/leads`],
    ["POST", "https://evil.example/matters"], ["POST", "http://api.fiveriverz.com/matters"], ["POST", `${api}:8443/matters`],
    ["POST", `${api}/matters/../contacts`.replace("/../contacts", "/x")],
  ];
  for (const [method, url] of refused) assert.equal(permitMattersRequest(url, method, "fetch", null), false, `${method} ${url}`);
  assert.equal(permitMattersRequest(`${api}/search/contacts`, "POST", "fetch", JSON.stringify({ params: {} })), false, "a search body without pagination is not a read");
});

// ---------- the native cases ----------

const linkedOk = (over = {}) => ({
  contact: { uuid: "c-uuid", correlation: { contractMatch: true, cardinalityOk: true } },
  matter: { uuid: "m-uuid", correlation: { contractMatch: true, cardinalityOk: true }, clientLinked: true, clientShownOnPage: true, screenshot: null, ...over },
});

function runnersFor(ctx, impl) {
  const runId = seedRun(ctx.db);
  return { runId, runners: buildNativeRunners({ apiContracts: ctx.apiContracts, mutationJournal: ctx.mutationJournal, runId, resourceOwnership: ctx.resourceOwnership, impl }) };
}
const ownedOf = (ctx, runId) => ctx.resourceOwnership.forRun(runId).map((o) => `${o.resource_type}:${o.resource_id}`).sort();

test("a Matter check passes only when both creates match their contracts AND the client link shows on the wire and on the page", async () => {
  await withApp(async (ctx) => {
    const cases = [
      ["all good", linkedOk(), true, null],
      ["matter contract mismatch", { ...linkedOk(), matter: { ...linkedOk().matter, correlation: { contractMatch: false, cardinalityOk: true, mismatchReason: "Shape drift: x" } } }, false, /matter create did not match its contract \(Shape drift: x\)/],
      ["contact contract mismatch", { ...linkedOk(), contact: { uuid: "c", correlation: { contractMatch: true, cardinalityOk: false, mismatchReason: "Expected exactly one" } } }, false, /contact create did not match its contract/],
      ["client not linked on re-read", linkedOk({ clientLinked: false, clientShownOnPage: false }), false, /did not list the contact as the matter's client/],
      ["client not shown on the page", linkedOk({ clientShownOnPage: false }), false, /never showed the client's name/],
    ];
    for (const [label, result, passed, reason] of cases) {
      const { runners } = runnersFor(ctx, { runMatterCreationForNewContactCheck: async () => result });
      const out = await runners["matters.create_for_new_contact"]();
      assert.equal(out.passed, passed, label);
      if (reason) assert.match(out.reason, reason, label);
    }
  });
});

test("both the contact and the matter are recorded as owned, as soon as each exists", async () => {
  await withApp(async (ctx) => {
    const { runId, runners } = runnersFor(ctx, {
      runMatterCreationForNewContactCheck: async ({ onCreated }) => { onCreated("contact", "c-1"); onCreated("matter", "m-1"); return linkedOk(); },
    });
    await runners["matters.create_for_new_contact"]();
    assert.deepEqual(ownedOf(ctx, runId), ["contact:c-1", "matter:m-1"]);
    for (const row of ctx.resourceOwnership.forRun(runId)) assert.equal(row.cleanup_policy, "manual", "nothing is scheduled for deletion");
  });
});

test("if the matter step fails AFTER the contact was created, the contact is still recorded as a leftover", async () => {
  await withApp(async (ctx) => {
    const { runId, runners } = runnersFor(ctx, {
      runMatterCreationForNewContactCheck: async ({ onCreated }) => { onCreated("contact", "c-2"); throw new Error("The Client picker never offered it."); },
    });
    await assert.rejects(runners["matters.create_for_new_contact"](), /never offered/);
    assert.deepEqual(ownedOf(ctx, runId), ["contact:c-2"]);
  });
});

test("Create clicked but no matter uuid confirmed is recorded as a 'may exist' leftover", async () => {
  await withApp(async (ctx) => {
    const { runId, runners } = runnersFor(ctx, {
      runMatterCreationForNewContactCheck: async ({ onCreated }) => { onCreated("contact", "c-3"); throw new Error("Could not determine the created matter's uuid from the post-save URL: /matters"); },
    });
    await assert.rejects(runners["matters.create_for_new_contact"](), /created matter's uuid/);
    const rows = ownedOf(ctx, runId);
    assert.ok(rows.includes("contact:c-3"));
    assert.ok(rows.some((row) => row.startsWith("matter_unconfirmed:")), rows.join(","));
  });
});

test("the validation case needs two messages, an open dialog, no create request and no navigation; it records nothing", async () => {
  await withApp(async (ctx) => {
    const good = { messageCount: 2, dialogStillOpen: true, noMatterCreated: true, stayedOnList: true, screenshot: null };
    for (const [label, result, passed] of [
      ["good", good, true], ["one message", { ...good, messageCount: 1 }, false], ["three messages", { ...good, messageCount: 3 }, false],
      ["dialog closed", { ...good, dialogStillOpen: false }, false], ["a matter was created", { ...good, noMatterCreated: false }, false], ["navigated away", { ...good, stayedOnList: false }, false],
    ]) {
      const { runId, runners } = runnersFor(ctx, { runMatterMandatoryFieldValidationCheck: async () => result });
      assert.equal((await runners["matters.create_mandatory_field_validation"]()).passed, passed, label);
      assert.deepEqual(ownedOf(ctx, runId), []);
    }
  });
});

test("the Matter cases are seeded into a Matters feature, runnable, not quarantined", () => {
  withApp(({ testbook }) => {
    seedLawcusNativeCases(testbook);
    const matters = testbook.tree().find((f) => f.name === "Matters");
    assert.ok(matters);
    const cases = matters.suites.flatMap((s) => s.cases);
    assert.deepEqual(cases.map((c) => c.externalId).sort(), ["matters.create_for_new_contact", "matters.create_mandatory_field_validation"]);
    assert.ok(cases.every((c) => c.runnable));
    assert.equal(NATIVE_QUARANTINE["matters.create_for_new_contact"], undefined);
  });
});

// ---------- the planner reaches the slice ----------

test("'create a matter for a new contact' plans exactly the two Matter cells; other wording, and the existing pattern, are unaffected", () => {
  withApp(({ testbook, knowledge }) => {
    seedLawcusNativeCases(testbook);
    const plan = (intent) => planImpactedTest({ intent, knowledge, testbook });
    for (const intent of ["Create a matter for a new contact.", "create a new matter for a contact and verify the client is linked", "Add a matter for a new contact and check that the contact is linked"]) {
      const p = plan(intent);
      assert.equal(p.matched, true, intent);
      assert.equal(p.patternId, "matter_for_contact");
      assert.deepEqual(p.cells.map((c) => c.externalId), ["matters.create_for_new_contact", "matters.create_mandatory_field_validation"]);
      assert.ok(p.cells.every((c) => c.covered), "seeded cases count as coverage");
      assert.equal(p.gaps.length, 0);
    }
    for (const intent of ["Delete every matter", "create a matter", "Create a matter for a new contact and then delete it", "create a matter for a new contact; drop table matters", "Delete all contacts and create a matter for a new contact", "Please create a matter for a new contact"]) {
      assert.equal(plan(intent).matched, false, intent);
    }
    assert.equal(plan("Update a contact custom field and check how it appears for existing/new Contact and Lead.").patternId, "contact_custom_field_impacted");
  });
});

// ---------- the Client picker ----------

// A fake page whose option locator records how it was filtered.
function fakePicker({ optionAppears }) {
  const log = { filters: [], clicks: [], typed: [], waits: 0 };
  const optionLocator = {
    filter(arg) { log.filters.push(arg); return optionLocator; },
    first() { return optionLocator; },
    async waitFor() { if (!optionAppears()) throw new Error("timeout"); },
    async click() { log.clicks.push("option"); },
  };
  const input = { async click() {}, async fill() {}, async pressSequentially(text) { log.typed.push(text); } };
  const dialog = { getByPlaceholder() { return { first: () => input }; } };
  const page = { locator(selector) { log.selector = selector; return optionLocator; }, async waitForTimeout() { log.waits += 1; } };
  return { page, dialog, log };
}
const CONTACT = { uuid: "u", searchText: "1790361709659", displayName: "QA Matter 1790361709659" };

test("the Client picker matches the contact's full name, excludes the Add row, and clicks the contact", async () => {
  const { page, dialog, log } = fakePicker({ optionAppears: () => true });
  await pickClient(page, dialog, CONTACT);
  assert.equal(log.selector, 'li[role="option"]');
  assert.deepEqual(log.filters[0], { hasText: CONTACT.displayName });
  const exclusion = log.filters[1].hasNotText;
  assert.ok(exclusion.test('Add "1790361709659"'), "the Add-a-contact row is excluded");
  assert.ok(!exclusion.test(CONTACT.displayName), "the contact's own row is not");
  assert.deepEqual(log.clicks, ["option"]);
});

test("the Client picker retries while a new contact is not searchable yet, and never clicks anything when it never appears", async () => {
  let calls = 0;
  const late = fakePicker({ optionAppears: () => ++calls >= 3 });
  await pickClient(late.page, late.dialog, CONTACT);
  assert.equal(late.log.typed.length, 3, "retyped until the contact appeared");
  assert.deepEqual(late.log.clicks, ["option"]);

  const never = fakePicker({ optionAppears: () => false });
  await assert.rejects(pickClient(never.page, never.dialog, CONTACT), /never offered "QA Matter 1790361709659" after 6 tries.*nothing was selected/);
  assert.deepEqual(never.log.clicks, [], "no click of any kind");
});

test("the browser module keeps its two live-found safeguards", () => {
  const source = readFileSync(new URL("../core/matters-browser.mjs", import.meta.url), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/**")).join("\n"); // code only
  assert.match(source, /page\.locator\('\[role="dialog"\]'\)\.first\(\)/, "CSS dialog locator, not getByRole");
  assert.doesNotMatch(source, /getByRole\("dialog"\)/);
  assert.match(source, /waitForFunction\(\(name\) => document\.body\.innerText\.includes\(`Client Name:\\n\$\{name\}`\)/, "waits for the client to replace the placeholder");
});
