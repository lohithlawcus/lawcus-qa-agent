import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openStore } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openFactCards } from "../core/fact-cards.mjs";
import { openChangeSignals } from "../core/change-signals.mjs";
import {
  McpToolError, MCP_ERROR, MCP_HOURLY_LIMIT, listFacts, getFact, listStaleFacts, planTestRequest,
  listChangeSignals, getChangeSignal, submitChangeSignal, proposeFactRevision, findAffectedFeatures,
} from "../mcp/tools.mjs";

// Nothing here may reach the real Keychain or launch a browser.
process.env.QA_FORBID_LIVE = "1";
const HUMAN = "operator:tester";
const SOURCE = { title: "Release notes 4.2" };

function withCtx(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-mcp-loop-"));
  try {
    const { db, audit } = openStore(dir);
    const knowledge = openKnowledge(db, audit);
    const testbook = openTestBook(db, audit);
    return fn({ db, audit, knowledge, testbook, factCards: openFactCards(db, { knowledge, testbook }), changeSignals: openChangeSignals(db, audit, { knowledge, testbook }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const propose = (ctx, over = {}) =>
  ctx.knowledge.proposeItem({ semanticId: "BR-CONTACT-EMAIL-001", type: "BUSINESS_RULE", featureName: "Contacts", featureDescription: "d", title: "Email rule", statement: "A contact email must be a valid address.", provenance: "DOCUMENTED", source: SOURCE, ...over });
const approved = (ctx, over) => ctx.knowledge.approveItem(propose(ctx, over).id, HUMAN);
const addCase = (ctx, feature, id) =>
  ctx.testbook.syncCases({ featureName: feature, featureDescription: "d", suiteName: "s", suiteDescription: "d", entries: { [id]: { source: `src-${id}`, definition: { id, name: id, layer: "both", risk: "normal", status: "approved" } } } });
const counts = (db) => Object.fromEntries(["runs", "scenario_results", "change_signals", "knowledge_items", "change_signal_items", "knowledge_review_flags"].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const code = (fn) => { try { fn(); return null; } catch (e) { return e instanceof McpToolError ? e.code : `other:${e.constructor.name}:${e.message}`; } };

// ---------- reading facts ----------

test("list_facts shows only approved facts by default; includeUnapproved adds the rest; filters work", () => {
  withCtx((ctx) => {
    approved(ctx);
    propose(ctx, { semanticId: "BR-PENDING-RULE-001", statement: "A pending statement." });
    approved(ctx, { semanticId: "BR-LEAD-RULE-001", featureName: "Leads", statement: "A lead statement." });
    assert.deepEqual(listFacts(ctx, {}).map((f) => f.semanticId).sort(), ["BR-CONTACT-EMAIL-001", "BR-LEAD-RULE-001"]);
    assert.equal(listFacts(ctx, { includeUnapproved: true }).length, 3);
    assert.deepEqual(listFacts(ctx, { feature: "Leads" }).map((f) => f.semanticId), ["BR-LEAD-RULE-001"]);
    assert.deepEqual(listFacts(ctx, { status: "pending", includeUnapproved: true }).map((f) => f.semanticId), ["BR-PENDING-RULE-001"]);
    assert.deepEqual(listFacts(ctx, { status: "pending" }), [], "a pending fact is not shown without includeUnapproved, even when asked for by state");
  });
});

test("get_fact marks an approved fact trusted, an unapproved one not trusted with a warning, and an unknown one not_found", () => {
  withCtx((ctx) => {
    approved(ctx);
    const pending = propose(ctx, { semanticId: "BR-PENDING-RULE-001", statement: "A pending statement." });
    const trusted = getFact(ctx, { reference: "BR-CONTACT-EMAIL-001" });
    assert.equal(trusted.trusted, true);
    assert.equal(trusted.warning, undefined);
    const untrusted = getFact(ctx, { reference: pending.id });
    assert.equal(untrusted.trusted, false);
    assert.match(untrusted.warning, /pending, not approved\. Do not treat it as a product rule/);
    assert.equal(code(() => getFact(ctx, { reference: "BR-NOPE-NOPE-001" })), MCP_ERROR.NOT_FOUND);
    assert.equal(code(() => getFact(ctx, { reference: "" })), MCP_ERROR.NOT_FOUND);
  });
});

test("list_stale_facts reports volatile facts past the age limit", () => {
  withCtx((ctx) => {
    const observed = ctx.knowledge.approveItem(propose(ctx, { provenance: "OBSERVED" }).id, HUMAN);
    assert.deepEqual(listStaleFacts(ctx, {}), []);
    ctx.db.prepare("UPDATE knowledge_items SET decided_at=? WHERE id=?").run(new Date(Date.now() - 200 * 86400000).toISOString(), observed.id);
    assert.deepEqual(listStaleFacts(ctx, { olderThanDays: 90 }).map((f) => f.semanticId), ["BR-CONTACT-EMAIL-001"]);
    assert.deepEqual(listStaleFacts(ctx, { olderThanDays: 365 }), []);
  });
});

// ---------- planning ----------

test("plan_test_request returns a labelled plan, blockers and review requests, refuses destructive requests, and writes nothing", () => {
  withCtx((ctx) => {
    addCase(ctx, "Contacts", "contacts.a");
    ctx.testbook.setAutomationReadiness("contacts.a", "ready");
    const before = counts(ctx.db);
    const ready = planTestRequest(ctx, { intent: "Verify Contacts" });
    assert.deepEqual([ready.matched, ready.origin, ready.status], [true, "graph", "ready"]);
    assert.deepEqual(ready.cells.map((c) => [c.externalId, c.covered]), [["contacts.a", true]]);
    assert.match(ready.cells[0].reasons[0], /Named in the request/);
    assert.match(ready.note, /nothing was run/);
    assert.ok(ready.reviewRequests.some((r) => r.kind === "no_known_relations"));
    const refused = planTestRequest(ctx, { intent: "Delete all contacts and test Contacts" });
    assert.deepEqual([refused.matched, refused.status, refused.cells], [false, "not_planned", []]);
    assert.equal(refused.reviewRequests[0].severity, "refused");
    assert.equal(planTestRequest(ctx, { intent: "Test Widgets" }).reviewRequests[0].kind, "unknown_feature");
    assert.equal(code(() => planTestRequest(ctx, { intent: "hi" })), MCP_ERROR.INVALID_INPUT);
    assert.equal(code(() => planTestRequest(ctx, { intent: 5 })), MCP_ERROR.INVALID_INPUT);
    assert.deepEqual(counts(ctx.db), before, "planning changed nothing");
  });
});

test("plan_test_request reports a blocked plan's blockers", () => {
  withCtx((ctx) => {
    addCase(ctx, "Contacts", "contacts.a");
    addCase(ctx, "Matters", "matters.undeclared");
    ctx.testbook.setAutomationReadiness("contacts.a", "ready");
    ctx.testbook.setAutomationReadiness("matters.undeclared", "ready");
    const edge = ctx.knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Matters", toFeatureName: "Contacts", rationale: "r", source: SOURCE });
    ctx.knowledge.approveEdge(edge.id, HUMAN);
    const plan = planTestRequest(ctx, { intent: "Verify Matters" });
    assert.equal(plan.status, "blocked");
    assert.ok(plan.blockers.some((b) => b.kind === "prerequisite_unmet"));
    assert.equal(plan.cells[0].blockedReason, "prerequisite_unmet");
  });
});

test("find_affected_features follows edge direction: a change to a dependency reaches its dependents, not the other way", () => {
  withCtx((ctx) => {
    for (const name of ["Matters", "Contacts"]) ctx.knowledge.ensureFeature(name, "d");
    ctx.knowledge.approveEdge(ctx.knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Matters", toFeatureName: "Contacts", rationale: "r", source: SOURCE }).id, HUMAN);
    assert.deepEqual(findAffectedFeatures(ctx, { featureName: "Contacts" }), ["Contacts", "Matters"]);
    assert.deepEqual(findAffectedFeatures(ctx, { featureName: "Matters" }), ["Matters"]);
  });
});

// ---------- change signals ----------

test("submit_change_signal records as 'mcp', analyzes, masks credentials, dedupes, validates and rate-limits", () => {
  withCtx((ctx) => {
    approved(ctx);
    const first = submitChangeSignal(ctx, { kind: "release_note", title: "Email rule tightened", body: "BR-CONTACT-EMAIL-001 rejects role addresses. password=Tr0ub4dor&3-fake" });
    assert.equal(first.submitted_by, "mcp");
    assert.equal(first.status, "analyzed");
    assert.equal(first.analysis.affectedFacts[0].semanticId, "BR-CONTACT-EMAIL-001");
    assert.ok(!JSON.stringify(ctx.db.prepare("SELECT * FROM change_signals").all()).includes("Tr0ub4dor"));
    const again = submitChangeSignal(ctx, { kind: "qa_note", title: "EMAIL rule tightened", body: "br-contact-email-001 rejects role addresses. password=Tr0ub4dor&3-fake" });
    assert.equal(again.duplicate, true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM change_signals").get().n, 1);
    assert.equal(code(() => submitChangeSignal(ctx, { kind: "rumour", title: "t", body: "b" })), MCP_ERROR.INVALID_INPUT);
    assert.equal(code(() => submitChangeSignal(ctx, { kind: "qa_note", title: "", body: "b" })), MCP_ERROR.INVALID_INPUT);
  });
});

test("the hourly cap counts only MCP submissions and only the last hour", () => {
  withCtx((ctx) => {
    const insert = (by, at, n) => ctx.db.prepare("INSERT INTO change_signals(id,kind,title,body,occurred_at,received_at,submitted_by,content_hash,status) VALUES(?,?,?,?,?,?,?,?,'new')")
      .run(randomUUID(), "qa_note", "t", "b", at, at, by, `${by}-${at}-${n}-${randomUUID()}`);
    for (let i = 0; i < 40; i++) insert("operator:someone", new Date().toISOString(), i);
    for (let i = 0; i < MCP_HOURLY_LIMIT; i++) insert("mcp", new Date(Date.now() - 2 * 3600000).toISOString(), i);
    assert.doesNotThrow(() => submitChangeSignal(ctx, { kind: "qa_note", title: "still allowed", body: "old MCP rows and human rows do not count" }));
    for (let i = 0; i < MCP_HOURLY_LIMIT; i++) insert("mcp", new Date().toISOString(), 100 + i);
    assert.equal(code(() => submitChangeSignal(ctx, { kind: "qa_note", title: "one too many", body: "x y z" })), MCP_ERROR.RATE_LIMITED);
  });
});

test("list_change_signals and get_change_signal read back what was recorded; an unknown id is not_found", () => {
  withCtx((ctx) => {
    approved(ctx);
    const signal = submitChangeSignal(ctx, { kind: "requirement", title: "New rule", body: "Contacts change." });
    assert.deepEqual(listChangeSignals(ctx, {}).map((s) => s.id), [signal.id]);
    assert.deepEqual(listChangeSignals(ctx, { status: "dismissed" }), []);
    const got = getChangeSignal(ctx, { signalId: signal.id });
    assert.equal(got.signal.id, signal.id);
    assert.ok(got.signal.analysis && got.diff);
    assert.equal(code(() => getChangeSignal(ctx, { signalId: randomUUID() })), MCP_ERROR.NOT_FOUND);
  });
});

// ---------- proposing revisions ----------

test("propose_fact_revision files a PENDING revision at inferred authority and leaves the approved fact alone", () => {
  withCtx((ctx) => {
    const fact = approved(ctx);
    const signal = submitChangeSignal(ctx, { kind: "release_note", title: "Change", body: "BR-CONTACT-EMAIL-001 changes." });
    const result = proposeFactRevision(ctx, { signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "A contact email must be valid and not a role address." });
    assert.equal(result.status, "pending_review");
    assert.match(result.note, /A person must approve/);
    assert.equal(result.before, fact.statement);
    const row = ctx.db.prepare("SELECT status, provenance, version FROM knowledge_items WHERE id=?").get(result.item.id);
    assert.deepEqual([row.status, row.provenance, row.version], ["pending_review", "INFERRED", 2]);
    assert.equal(ctx.db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(fact.id).status, "approved");
    // The revision's source records who filed it
    assert.equal(ctx.db.prepare("SELECT author FROM knowledge_sources WHERE id=(SELECT source_id FROM knowledge_items WHERE id=?)").get(result.item.id).author, "mcp");
  });
});

test("an MCP revision cannot claim documented or product-approved authority", () => {
  withCtx((ctx) => {
    approved(ctx);
    const signal = submitChangeSignal(ctx, { kind: "release_note", title: "Change", body: "BR-CONTACT-EMAIL-001 changes." });
    const before = counts(ctx.db);
    for (const provenance of ["DOCUMENTED", "PRODUCT_APPROVED", "DEPRECATED", "made_up", ""]) {
      assert.equal(code(() => proposeFactRevision(ctx, { signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "A revised statement.", provenance })), MCP_ERROR.INVALID_INPUT, provenance);
    }
    assert.deepEqual(counts(ctx.db), before, "nothing was filed");
    for (const provenance of ["OBSERVED", "INFERRED", "ASSUMED"]) {
      assert.doesNotThrow(() => proposeFactRevision(ctx, { signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: `Revised as ${provenance}.`, provenance }));
    }
  });
});

test("propose_fact_revision reports clear errors: no such fact, no such signal, a credential in the text, a dismissed signal", () => {
  withCtx((ctx) => {
    approved(ctx);
    const signal = submitChangeSignal(ctx, { kind: "release_note", title: "Change", body: "BR-CONTACT-EMAIL-001 changes." });
    const revise = (over) => proposeFactRevision(ctx, { signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "A revised statement.", ...over });
    assert.equal(code(() => revise({ semanticId: "BR-NOPE-NOPE-001" })), MCP_ERROR.INVALID_INPUT);
    assert.equal(code(() => revise({ signalId: randomUUID() })), MCP_ERROR.NOT_FOUND);
    assert.equal(code(() => revise({ statement: "use password=hunter2secret here" })), MCP_ERROR.INVALID_INPUT);
    assert.equal(code(() => revise({ statement: "" })), MCP_ERROR.INVALID_INPUT);
    ctx.changeSignals.dismiss({ signalId: signal.id, actor: HUMAN });
    assert.equal(code(() => revise({})), MCP_ERROR.INVALID_INPUT);
  });
});

test("propose_fact_revision is rate-limited", () => {
  withCtx((ctx) => {
    approved(ctx);
    const signal = submitChangeSignal(ctx, { kind: "release_note", title: "Change", body: "BR-CONTACT-EMAIL-001 changes." });
    const item = ctx.db.prepare("SELECT id FROM knowledge_items LIMIT 1").get().id;
    // Fill the last hour: one revision link per distinct signal (a link is unique per signal and item).
    for (let i = 0; i < MCP_HOURLY_LIMIT; i++) {
      const id = randomUUID();
      const at = new Date().toISOString();
      ctx.db.prepare("INSERT INTO change_signals(id,kind,title,body,occurred_at,received_at,submitted_by,content_hash,status) VALUES(?,?,?,?,?,?,?,?,'new')").run(id, "qa_note", "t", "b", at, at, HUMAN, `h-${id}`);
      ctx.db.prepare("INSERT INTO change_signal_items(id,signal_id,knowledge_item_id,relation,created_at) VALUES(?,?,?,'proposes',?)").run(randomUUID(), id, item, at);
    }
    assert.equal(code(() => proposeFactRevision(ctx, { signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "One too many." })), MCP_ERROR.RATE_LIMITED);
  });
});

test("an MCP-filed revision cannot be approved without an acknowledgement, and the MCP identity cannot decide anything", () => {
  withCtx((ctx) => {
    approved(ctx);
    const signal = submitChangeSignal(ctx, { kind: "release_note", title: "Change", body: "BR-CONTACT-EMAIL-001 changes." });
    const filed = proposeFactRevision(ctx, { signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "A revised statement." });
    // a person approving weaker evidence over a documented fact must acknowledge it
    assert.throws(() => ctx.knowledge.approveItem(filed.item.id, HUMAN), (e) => e.code === "lower_authority");
    // the MCP identity is refused at every decision point
    const item = ctx.db.prepare("SELECT id FROM knowledge_items WHERE status='approved'").get().id;
    assert.throws(() => ctx.knowledge.approveItem(filed.item.id, "mcp"), (e) => e.code === "non_human_approver");
    assert.throws(() => ctx.knowledge.rejectItem(filed.item.id, "mcp"), (e) => e.code === "non_human_approver");
    assert.throws(() => ctx.changeSignals.flagForReview({ signalId: signal.id, itemId: item, actor: "mcp" }), (e) => e.code === "non_human_approver");
    assert.throws(() => ctx.changeSignals.dismiss({ signalId: signal.id, actor: "mcp" }), (e) => e.code === "non_human_approver");
    assert.throws(() => ctx.knowledge.collapseDuplicates({ approver: "mcp", apply: true }), (e) => e.code === "non_human_approver");
  });
});

// ---------- the real MCP server over stdio ----------

const EXPECTED_TOOLS = [
  "search_lawcus_knowledge", "get_feature_rules", "find_affected_features", "find_relevant_test_suites", "read_test_case", "read_api_contract",
  "create_test_proposal", "create_failure_analysis_proposal", "list_pending_proposals", "run_approved_test", "run_approved_suite",
  "get_run_status", "get_run_results", "get_failure_evidence_summary",
  "list_facts", "get_fact", "list_stale_facts", "plan_test_request", "list_change_signals", "get_change_signal", "submit_change_signal", "propose_fact_revision",
];
// Verbs that mean "a person decides"; matched against whole name segments (so run_approved_test is fine).
const FORBIDDEN = ["approve", "reject", "dismiss", "flag", "resolve", "collapse", "delete", "cleanup", "accept", "import", "scope"];

async function withServer(fn) {
  const cwd = mkdtempSync(join(tmpdir(), "qa-mcp-stdio-"));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))],
    cwd,
    env: { ...process.env, QA_FORBID_LIVE: "1" },
    stderr: "ignore",
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
}
const parse = (result) => JSON.parse(result.content[0].text);

test("the running MCP server exposes exactly the reviewed tools and none that decides anything", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
    for (const name of names) for (const word of FORBIDDEN) assert.ok(!name.split("_").includes(word), `${name} contains the decision verb "${word}"`);
    const schema = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(schema.propose_fact_revision.properties.provenance.enum, ["OBSERVED", "INFERRED", "ASSUMED"], "documented / product-approved cannot even be expressed");
  });
});

test("over the wire: a signal is recorded, masked, analyzed and read back; errors are shaped; bad input is refused by schema", async () => {
  await withServer(async (client) => {
    const call = (name, args) => client.callTool({ name, arguments: args });
    const submitted = await call("submit_change_signal", { kind: "release_note", title: "Login change", body: "Sign-in now asks for a code. Bearer abcDEF1234567890xyzFAKE and password=Tr0ub4dor&3-fake were pasted." });
    assert.ok(!submitted.isError, submitted.content[0].text);
    const signal = parse(submitted);
    assert.equal(signal.submitted_by, "mcp");
    assert.ok(!submitted.content[0].text.includes("Tr0ub4dor") && !submitted.content[0].text.includes("abcDEF1234567890xyzFAKE"), "credentials never come back");
    const read = parse(await call("get_change_signal", { signalId: signal.id }));
    assert.equal(read.signal.title, "Login change");
    assert.equal(parse(await call("list_change_signals", {})).length, 1);
    const duplicate = parse(await call("submit_change_signal", { kind: "qa_note", title: "Login change", body: signal.body }));
    assert.equal(duplicate.duplicate, true);

    const missing = await call("get_fact", { reference: "BR-NOPE-NOPE-001" });
    assert.equal(missing.isError, true);
    assert.equal(parse(missing).error, "not_found");
    const noRevisionTarget = await call("propose_fact_revision", { signalId: signal.id, semanticId: "BR-NOPE-NOPE-001", statement: "x y z" });
    assert.equal(noRevisionTarget.isError, true);
    assert.equal(parse(noRevisionTarget).error, "invalid_input");

    const badProvenance = await call("propose_fact_revision", { signalId: signal.id, semanticId: "BR-A-B-001", statement: "x", provenance: "DOCUMENTED" }).catch((e) => ({ isError: true, thrown: String(e.message) }));
    assert.equal(badProvenance.isError, true, "the schema refuses a documented claim");
    const badId = await call("get_change_signal", { signalId: "not-a-uuid" }).catch((e) => ({ isError: true, thrown: String(e.message) }));
    assert.equal(badId.isError, true);

    const refused = parse(await call("plan_test_request", { intent: "Delete all contacts and test Contacts" }));
    assert.deepEqual([refused.matched, refused.status], [false, "not_planned"]);
    assert.equal(refused.reviewRequests[0].severity, "refused");
    assert.deepEqual(parse(await call("list_facts", {})), []);
  });
});
