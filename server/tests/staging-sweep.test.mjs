import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openStagingSweeps, isQaNamed, permitSweepRequest, defaultCutoff, SWEEP_KINDS } from "../core/staging-sweep.mjs";
import { checkStagingBudget, stagingBusy, STAGING_RUN_LIMIT } from "../core/run-admission.mjs";
import { readTenantLists, tenantTimestamp } from "../core/sweep-browser.mjs";
import { PROTECTED_RESOURCE_IDS } from "../testbook/lawcus-native-cases.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";
const HUMAN = "operator:tester";

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-sweep-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({ db, audit, dir, sweeps: openStagingSweeps(db, audit, { protectedResourceIds: PROTECTED_RESOURCE_IDS }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function seedRun(db, startedAt = new Date().toISOString(), status = "passed") {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(runbookId, 1, "lawcus", "t", "i", "built-in", JSON.stringify({ title: "Login essentials", scenarios: ["valid_login"] }), new Date().toISOString());
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(runId, runbookId, status, 0, startedAt);
  return runId;
}
const own = (db, runId, type, id) =>
  db.prepare("INSERT INTO resource_ownership(id,run_id,environment_id,resource_type,resource_id,created_by_primitive,cleanup_policy,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), runId, "lawcus", type, id, "test", "manual", new Date().toISOString());
const rec = (name, id = randomUUID(), createdAt = "2026-09-20 10:00:00") => ({ id, name, createdAt });

// ---------- names ----------

test("only this tool's own naming marks a candidate; ordinary and lookalike names do not", () => {
  for (const name of ["QA Agent 1790357433737", "QA Agent - 1789484203935", "QA Matter 1790362380870", "QAFieldTest1790000000000", "QA Batch Test", "QA impacted-test 179", "  qa agent 12", "QA Agent"]) assert.equal(isQaNamed(name), true, name);
  for (const name of ["Aaron Elliott", "Pestos", "The QA Agent", "Quality Agent", "QAgent 12", "Q A Agent", "", "   ", null, undefined, 5, {}]) assert.equal(isQaNamed(name), false, String(name));
});

// ---------- the read-only policy ----------

test("a sweep's browser may read, and may POST only the tenant's own list endpoints with a paging body", () => {
  const api = "https://api.fiveriverz.com";
  const paging = JSON.stringify({ filters: [], pagination: { skip: 0, take: 25 }, multi_sorting: [{ order: "desc", field: "created_at" }] });
  for (const path of ["/v2/contacts", "/v2/matters", "/v2/leads"]) assert.equal(permitSweepRequest(`${api}${path}`, "POST", "fetch", paging), true, path);
  assert.equal(permitSweepRequest(`${api}/v2/leads`, "POST", "fetch", JSON.stringify({ filters: [], pagination: { skip: 0, take: 1000 }, sort: [] })), true);
  assert.equal(permitSweepRequest(`${api}/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381`, "GET", "fetch", null), true);
  assert.equal(permitSweepRequest("https://lohith.fiveriverz.com/contacts", "GET", "document", null), true);
  assert.equal(permitSweepRequest(`${api}/login`, "POST", "fetch", "{}"), true, "signing in is allowed");
});

test("every write is refused: creates, edits, deletes, searches, settings, and malformed or widened list bodies", () => {
  const api = "https://api.fiveriverz.com";
  const paging = JSON.stringify({ filters: [], pagination: { skip: 0, take: 25 } });
  const refused = [
    ["PUT", `${api}/settings/user`, JSON.stringify({ layout: "listview" })], ["POST", `${api}/contacts`, paging], ["POST", `${api}/matters`, paging], ["POST", `${api}/leads`, paging],
    ["PUT", `${api}/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381`, "{}"], ["DELETE", `${api}/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381`, null],
    ["POST", `${api}/search/contacts`, paging], ["POST", `${api}/search/matters`, paging], ["POST", `${api}/releases/list`, paging],
    ["PUT", `${api}/v2/contacts`, paging], ["PATCH", `${api}/v2/matters`, paging], ["DELETE", `${api}/v2/leads`, paging],
    ["POST", `${api}/v2/contacts`, JSON.stringify({ filters: [] })], ["POST", `${api}/v2/contacts`, "{}"], ["POST", `${api}/v2/contacts`, "[]"], ["POST", `${api}/v2/contacts`, "not json"], ["POST", `${api}/v2/contacts`, null],
    ["POST", `${api}/v2/contacts`, JSON.stringify({ pagination: { skip: 0, take: 25 }, first_name: "x" })], ["POST", `${api}/v2/contacts`, JSON.stringify({ pagination: { skip: 0, take: 25 }, custom_fields: [] })],
    ["POST", `${api}/v2/contacts/e2bf71a0-ae87-11f1-ab8e-f18331cbd381`, paging], ["POST", `${api}/v2/contacts/`, paging],
    ["POST", "https://lohith.fiveriverz.com/v2/contacts", paging], ["POST", "https://evil.example/v2/contacts", paging], ["POST", "http://api.fiveriverz.com/v2/contacts", paging], ["POST", `${api}:8443/v2/contacts`, paging],
    ["POST", "https://user:pw@api.fiveriverz.com/v2/contacts", paging],
  ];
  for (const [method, url, postData] of refused) assert.equal(permitSweepRequest(url, method, "fetch", postData), false, `${method} ${url} ${String(postData).slice(0, 40)}`);
});

// ---------- cutoff ----------

test("the default cutoff is a day before the first recorded run, or 31 days back (30 plus the margin) when there is none", () => {
  withApp(({ db }) => {
    const nowMs = Date.parse("2026-09-25T12:00:00Z");
    assert.equal(defaultCutoff(db, nowMs), "2026-08-25T12:00:00.000Z");
    seedRun(db, "2026-09-15T20:14:00.000Z");
    seedRun(db, "2026-09-20T10:00:00.000Z");
    assert.equal(defaultCutoff(db, nowMs), "2026-09-14T20:14:00.000Z");
  });
});

// ---------- running a sweep ----------

test("only this tool's records are stored, classified against ownership, with the rest of the tenant never kept", async () => {
  await withApp(async ({ db, sweeps }) => {
    const runId = seedRun(db);
    const trackedId = randomUUID();
    own(db, runId, "contact", trackedId);
    const protectedId = PROTECTED_RESOURCE_IDS[0];
    const untrackedId = randomUUID();
    const sweepId = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    const result = await sweeps.run({
      sweepId,
      reader: async () => ({
        contact: { records: [rec("QA Agent 111", trackedId), rec("QA Batch Test", protectedId), rec("QA Agent 222", untrackedId), rec("Aaron Elliott"), rec("Someone Else Entirely"), rec("QA Agent 222", untrackedId)], scanned: 250, pagesRead: 10, truncated: false, totalInTenant: 254850 },
        matter: { records: [rec("QA Matter 333"), rec("Robert matter")], scanned: 300, pagesRead: 3, truncated: false, totalInTenant: 64834 },
        lead: { records: [rec("QA Agent - 444")], scanned: 75, pagesRead: 1, truncated: false, totalInTenant: 75 },
      }),
    });
    assert.equal(result.status, "completed");
    assert.deepEqual([result.matched_count, result.untracked_count], [5, 3]);
    assert.match(result.summary, /Found 5 candidate record\(s\), 3 not known to this tool\. Every list was read back to the cutoff date\./);
    assert.deepEqual(result.scanned.contact, { scanned: 250, pagesRead: 10, truncated: false, totalInTenant: 254850 });
    const stored = db.prepare("SELECT kind, name, disposition, ownership_run_id FROM staging_sweep_records ORDER BY name").all();
    assert.deepEqual(stored.map((r) => r.name), ["QA Agent - 444", "QA Agent 111", "QA Agent 222", "QA Batch Test", "QA Matter 333"], "deduplicated, nobody else's names");
    const by = Object.fromEntries(stored.map((r) => [r.name, r]));
    assert.deepEqual([by["QA Agent 111"].disposition, by["QA Agent 111"].ownership_run_id], ["tracked", runId]);
    assert.equal(by["QA Batch Test"].disposition, "protected");
    assert.equal(by["QA Agent 222"].disposition, "untracked");
    assert.equal(by["QA Matter 333"].kind, "matter");
    assert.equal(by["QA Agent - 444"].kind, "lead");
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM staging_sweep_records").all()).includes("Aaron Elliott"));
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM staging_sweeps").all()).includes("Aaron Elliott"));
  });
});

test("a record is tracked only when its KIND matches: a contact id owned as a matter is not tracked as a contact", async () => {
  await withApp(async ({ db, sweeps }) => {
    const runId = seedRun(db);
    const id = randomUUID();
    own(db, runId, "matter", id);
    const sweepId = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    await sweeps.run({ sweepId, reader: async () => ({ contact: { records: [rec("QA Agent 1", id)], scanned: 1 } }) });
    assert.equal(db.prepare("SELECT disposition FROM staging_sweep_records").get().disposition, "untracked");
  });
});

test("a list that did not reach the cutoff makes the sweep PARTIAL, and says older records may be missing", async () => {
  await withApp(async ({ sweeps }) => {
    const sweepId = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    const result = await sweeps.run({ sweepId, reader: async () => ({ contact: { records: [rec("QA Agent 1")], scanned: 1500, pagesRead: 60, truncated: true, totalInTenant: 254850 }, matter: { records: [], scanned: 10, truncated: false } }) });
    assert.equal(result.status, "partial");
    assert.match(result.summary, /did not reach the cutoff date in every list, so older candidates may be missing/);
    assert.equal(result.scanned.contact.truncated, true);
  });
});

test("an empty result is a completed sweep that found nothing; records with no id are skipped", async () => {
  await withApp(async ({ db, sweeps }) => {
    const sweepId = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    const result = await sweeps.run({ sweepId, reader: async () => ({ contact: { records: [{ name: "QA Agent 1" }, { id: "", name: "QA Agent 2" }], scanned: 2 }, matter: undefined }) });
    assert.deepEqual([result.status, result.matched_count], ["completed", 0]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM staging_sweep_records").get().n, 0);
  });
});

test("a failed sweep records what kind of failure it was, keeps no partial records, and says nothing was found or changed", async () => {
  await withApp(async ({ db, sweeps }) => {
    const login = "locator.waitFor: Timeout 35000ms exceeded.\nCall log:\n  - waiting for getByPlaceholder('Search your practice', { exact: true }) to be visible";
    const first = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    const failed = await sweeps.run({ sweepId: first, reader: async () => { throw new Error(login); } });
    assert.deepEqual([failed.status, failed.failure_class, failed.reason_code], ["failed", "infrastructure", "login_timeout"]);
    assert.match(failed.summary, /Nothing was found or changed\.$/);
    const second = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    const odd = await sweeps.run({ sweepId: second, reader: async () => { throw new Error("something entirely new"); } });
    assert.deepEqual([odd.status, odd.failure_class], ["failed", "unclassified"]);
    // a failure half way through storing rolls the whole sweep's records back
    const third = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    function* dies() { yield rec("QA Agent 1"); yield rec("QA Agent 2"); throw new Error("net::ERR_NAME_NOT_RESOLVED at https://x"); }
    const halfway = await sweeps.run({ sweepId: third, reader: async () => ({ contact: { records: dies(), scanned: 3 } }) });
    assert.deepEqual([halfway.status, halfway.reason_code], ["failed", "network_unreachable"]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM staging_sweep_records").get().n, 0);
    assert.deepEqual(halfway.records, []);
  });
});

test("credentials in an error never reach the stored summary", async () => {
  await withApp(async ({ sweeps }) => {
    const id = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    const result = await sweeps.run({ sweepId: id, reader: async () => { throw new Error("failed with password=Tr0ub4dor&3-fake and Bearer abcDEF1234567890xyzFAKE"); } });
    assert.ok(!result.summary.includes("Tr0ub4dor") && !result.summary.includes("abcDEF1234567890xyzFAKE"), result.summary);
  });
});

// ---------- one at a time ----------

test("only one sweep may run at a time, one must say who asked, and a finished one frees the slot", async () => {
  await withApp(async ({ sweeps }) => {
    assert.throws(() => sweeps.begin({ environmentId: "lawcus", requestedBy: "" }), /who asked/);
    const first = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    assert.throws(() => sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN }), (e) => e.code === "sweep_running");
    await sweeps.run({ sweepId: first, reader: async () => ({}) });
    assert.doesNotThrow(() => sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN }));
    await assert.rejects(sweeps.run({ sweepId: first, reader: async () => ({}) }), /not running/, "a finished sweep cannot be run again");
  });
});

// ---------- the shared staging account ----------

test("a sweep spends the staging sign-in budget and blocks runs while it is running", async () => {
  await withApp(async ({ db, sweeps }) => {
    assert.equal(stagingBusy(db), false);
    for (let i = 0; i < STAGING_RUN_LIMIT - 1; i++) seedRun(db);
    assert.equal(checkStagingBudget(db, "lawcus").ok, true);
    const id = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    assert.equal(stagingBusy(db), true, "a running sweep blocks runs");
    assert.deepEqual([checkStagingBudget(db, "lawcus").ok, checkStagingBudget(db, "lawcus").recent], [false, STAGING_RUN_LIMIT], "the sweep counts as a sign-in");
    await sweeps.run({ sweepId: id, reader: async () => ({}) });
    assert.equal(stagingBusy(db), false);
    assert.equal(checkStagingBudget(db, "lawcus", { nowMs: Date.now() + 11 * 60000 }).ok, true, "the window moves on");
    seedRun(db, new Date().toISOString(), "running");
    assert.equal(stagingBusy(db), true, "and a running run blocks a sweep");
  });
});

test("a sweep left 'running' by a crash is cleared when the service next starts, so it cannot block staging for good", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-sweep-stale-"));
  try {
    const first = openStore(dir);
    const stale = randomUUID();
    const fresh = randomUUID();
    const insert = (id, at) => first.db.prepare("INSERT INTO staging_sweeps(id,environment_id,status,cutoff,started_at,requested_by) VALUES(?,?,'running',?,?,?)").run(id, "lawcus", at, at, HUMAN);
    insert(stale, new Date(Date.now() - 30 * 60000).toISOString());
    insert(fresh, new Date().toISOString());
    const second = openStore(dir);
    const rows = Object.fromEntries(second.db.prepare("SELECT id,status,summary FROM staging_sweeps").all().map((r) => [r.id, r]));
    assert.equal(rows[stale].status, "failed");
    assert.match(rows[stale].summary, /service stopped before this sweep finished/);
    assert.equal(rows[fresh].status, "running", "a healthy, recent sweep is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- review ----------

test("only a person can review a finding; the finding's classification is unchanged and staging is not touched", async () => {
  await withApp(async ({ db, sweeps }) => {
    const id = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    await sweeps.run({ sweepId: id, reader: async () => ({ contact: { records: [rec("QA Agent 1")], scanned: 1 } }) });
    const row = db.prepare("SELECT * FROM staging_sweep_records").get();
    assert.equal(row.review_status, "unreviewed");
    for (const actor of ["mcp", "ai_extraction", "runner", "", undefined]) assert.throws(() => sweeps.review(row.id, { status: "confirmed_qa", actor }), /./, String(actor));
    assert.throws(() => sweeps.review(row.id, { status: "delete_it", actor: HUMAN }), /Review status must be one of/);
    assert.equal(sweeps.review(row.id, { status: "left_in_place", note: "keep for now", actor: HUMAN }).review_status, "left_in_place");
    const after = db.prepare("SELECT * FROM staging_sweep_records WHERE id=?").get(row.id);
    assert.deepEqual([after.review_note, after.reviewed_by, after.disposition], ["keep for now", HUMAN, "untracked"]);
    assert.ok(after.reviewed_at);
    assert.throws(() => sweeps.review(randomUUID(), { status: "not_qa", actor: HUMAN }), (e) => e.code === "not_found");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='staging_sweep.record_reviewed'").get().n, 1);
  });
});

test("get() lists untracked findings first and list() newest first; an unknown id is null", async () => {
  await withApp(async ({ db, sweeps }) => {
    const runId = seedRun(db);
    const tracked = randomUUID();
    own(db, runId, "contact", tracked);
    const a = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    await sweeps.run({ sweepId: a, reader: async () => ({ contact: { records: [rec("QA Agent 1", tracked, "2026-09-25 10:00:00"), rec("QA Agent 2", randomUUID(), "2026-09-16 10:00:00")], scanned: 2 } }) });
    assert.deepEqual(sweeps.get(a).records.map((r) => r.disposition), ["untracked", "tracked"]);
    await new Promise((r) => setTimeout(r, 5));
    const b = sweeps.begin({ environmentId: "lawcus", requestedBy: HUMAN });
    await sweeps.run({ sweepId: b, reader: async () => ({}) });
    assert.deepEqual(sweeps.list().map((s) => s.id), [b, a]);
    assert.equal(sweeps.get(randomUUID()), null);
  });
});

// ---------- the browser reader, against a fake tenant page ----------

// A fake Lawcus list page: goto() and the "next page" button answer with the same
// list responses the real app does, so the reader's paging can be exercised.
function fakeTenant({ contacts = [], matters = [], leads = [], take = { contacts: 25, matters: 100, leads: 1000 }, nextEnabled = true } = {}) {
  const log = { gotos: [], clicks: [], typed: 0, filled: 0 };
  const data = { "/contacts": { items: contacts, endpoint: "/v2/contacts", take: take.contacts }, "/matters": { items: matters, endpoint: "/v2/matters", take: take.matters }, "/leads": { items: leads, endpoint: "/v2/leads", take: take.leads } };
  const context = {
    async newPage() {
      let current = null;
      let skip = 0;
      const waiters = [];
      const respond = (from) => {
        const { items, endpoint, take: size } = data[current];
        const slice = items.slice(from, from + size);
        const response = {
          url: () => `https://api.fiveriverz.com${endpoint}`,
          request: () => ({ method: () => "POST", postDataJSON: () => ({ filters: [], pagination: { skip: from, take: size } }) }),
          json: async () => ({ list: slice, total: items.length }),
        };
        for (const waiter of [...waiters]) if (waiter.predicate(response)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(response); }
      };
      return {
        waitForResponse: (predicate) => new Promise((resolve) => waiters.push({ predicate, resolve })),
        async goto(url) { current = new URL(url).pathname; log.gotos.push(current); skip = 0; queueMicrotask(() => respond(0)); },
        locator: (selector) => ({
          first: () => ({
            async count() { return selector === '[aria-label="Go to next page"]' ? 1 : 0; },
            async isEnabled() { return nextEnabled; },
            async click() { log.clicks.push(selector); skip += data[current].take; queueMicrotask(() => respond(skip)); },
            async fill() { log.filled += 1; }, async pressSequentially() { log.typed += 1; },
          }),
        }),
        async close() {},
      };
    },
  };
  return { context, log };
}
const newestFirst = (n, make, startDay = 25) => Array.from({ length: n }, (_, i) => make(i, `2026-09-${String(Math.max(1, startDay - Math.floor(i / 5))).padStart(2, "0")} 12:00:00`));
const item = (uuid, name, created_at) => ({ uuid, name, created_at });

test("tenantTimestamp uses the tenant's own timestamp format", () => {
  assert.equal(tenantTimestamp("2026-09-15T00:00:00.000Z"), "2026-09-15 00:00:00");
});

test("the reader pages until it passes the cutoff, keeps only QA-named records from the cutoff on, and drops everyone else's", async () => {
  // 100 contacts, 5 per day newest first; every 4th is QA-named. Cutoff 2026-09-20.
  const contacts = newestFirst(100, (i, at) => item(`c${i}`, i % 4 === 0 ? `QA Agent ${i}` : `Person ${i}`, at));
  const { context, log } = fakeTenant({ contacts });
  const result = await readTenantLists({ context, cutoff: "2026-09-20T00:00:00.000Z" });
  assert.equal(result.contact.truncated, false);
  assert.ok(result.contact.pagesRead >= 2 && result.contact.pagesRead <= 4, `pages: ${result.contact.pagesRead}`);
  assert.equal(result.contact.totalInTenant, 100);
  assert.ok(result.contact.records.every((r) => /^QA Agent/.test(r.name) && r.createdAt >= "2026-09-20 00:00:00"));
  assert.ok(result.contact.records.length >= 5);
  assert.ok(!JSON.stringify(result).includes("Person "), "other people's records are dropped");
  assert.ok(result.contact.scanned <= 100 && result.contact.scanned >= 25);
  // it stopped early: it did not read all four pages of a hundred
  assert.ok(log.clicks.length < 4);
});

test("the reader stops at the last page, and when the pager is disabled", async () => {
  const few = Array.from({ length: 10 }, (_, i) => item(`c${i}`, `QA Agent ${i}`, "2026-09-25 12:00:00"));
  const single = await readTenantLists({ context: fakeTenant({ contacts: few }).context, cutoff: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual([single.contact.pagesRead, single.contact.records.length, single.contact.truncated], [1, 10, false]);
  const many = Array.from({ length: 60 }, (_, i) => item(`c${i}`, `QA Agent ${i}`, "2026-09-25 12:00:00"));
  const { context, log } = fakeTenant({ contacts: many, nextEnabled: false });
  const disabled = await readTenantLists({ context, cutoff: "2026-09-01T00:00:00.000Z" });
  assert.equal(disabled.contact.pagesRead, 1);
  assert.deepEqual(log.clicks, [], "a disabled pager is never clicked");
});

test("a list that cannot be read back to the cutoff within its page limit is reported truncated", async () => {
  const leads = Array.from({ length: 1000 }, (_, i) => item(`l${i}`, i < 3 ? `QA Agent - ${i}` : `Lead ${i}`, "2026-09-25 12:00:00"));
  const result = await readTenantLists({ context: fakeTenant({ leads }).context, cutoff: "2026-09-01T00:00:00.000Z" });
  assert.equal(result.lead.truncated, true, "a full single page of leads with the cutoff not reached");
  assert.equal(result.lead.records.length, 3);
});

test("the reader only loads the three list pages and clicks the pager: it never types, fills or clicks anything else", async () => {
  const contacts = newestFirst(60, (i, at) => item(`c${i}`, `QA Agent ${i}`, at));
  const { context, log } = fakeTenant({ contacts, matters: contacts, leads: [] });
  await readTenantLists({ context, cutoff: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(log.gotos, ["/contacts", "/matters", "/leads"]);
  assert.ok(log.clicks.every((selector) => selector === '[aria-label="Go to next page"]'));
  assert.deepEqual([log.typed, log.filled], [0, 0], "nothing is typed: the global search box would write to the account's settings");
  assert.deepEqual(Object.keys((await readTenantLists({ context: fakeTenant({}).context, cutoff: "2026-09-01T00:00:00.000Z" }))).sort(), [...SWEEP_KINDS].sort());
});

// ---------- wiring ----------

test("the routes carry the same guards as a staging run, every 'already running' check includes sweeps, and the policy is the read-only one", () => {
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(index, /SELECT 1 FROM runs WHERE status='running'/, "no guard looks at runs alone");
  assert.ok((index.match(/stagingBusy\(db\)/g) || []).length >= 8);
  const tools = readFileSync(new URL("../mcp/tools.mjs", import.meta.url), "utf8");
  assert.match(tools, /stagingBusy\(db\)/);
  const start = index.slice(index.indexOf('pathname === "/sweeps") {'), index.indexOf("stagingSweeps.begin("));
  for (const guard of ["browserStatus.ready", 'keychain("exists"', "stagingBusy(db)", "checkStagingBudget(db"]) assert.ok(start.includes(guard), guard);
  assert.match(index, /stagingSweeps\.review\(hit\[1\], \{ \.\.\.input, actor: approverIdentity \}\)/);
  const live = readFileSync(new URL("../core/live-runner.mjs", import.meta.url), "utf8");
  assert.match(live, /withLoggedInContext\(permitSweepRequest,/);
  assert.doesNotMatch(live.slice(live.indexOf("runStagingSweepRead")), /permitContactsRequest|permitMattersRequest|permitLeadsRequest/);
  assert.match(readFileSync(new URL("../core/sweep-browser.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, ""), /^(?![\s\S]*\.(fill|pressSequentially|type|check|selectOption|setInputFiles)\()/, "the reader never types");
});
