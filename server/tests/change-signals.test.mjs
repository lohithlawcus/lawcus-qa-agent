import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openKnowledge } from "../core/knowledge.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { openChangeSignals } from "../core/change-signals.mjs";
import { planImpactedTest } from "../core/impacted-testing.mjs";
import { clearRegisteredSecrets } from "../core/redact.mjs";

process.env.QA_FORBID_LIVE = "1";
const HUMAN = "operator:tester";

function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-change-"));
  try {
    const { db, audit } = openStore(dir);
    const knowledge = openKnowledge(db, audit);
    const testbook = openTestBook(db, audit);
    const signals = openChangeSignals(db, audit, { knowledge, testbook });
    return fn({ db, audit, knowledge, testbook, signals });
  } finally {
    clearRegisteredSecrets();
    rmSync(dir, { recursive: true, force: true });
  }
}

function caseEntry(id) {
  return { source: `src-${id}`, definition: { id, name: id, layer: "both", risk: "normal", status: "approved" } };
}

// Contacts: two approved facts (one linked to a test) and three cases (one
// quarantined). Leads: one fact, one case, connected to Contacts by an
// approved edge. Billing: unrelated.
function seed({ knowledge, testbook }) {
  testbook.syncCases({ featureName: "Contacts", featureDescription: "d", suiteName: "s", suiteDescription: "d",
    entries: { "contacts.create": caseEntry("contacts.create"), "contacts.edit": caseEntry("contacts.edit"), "contacts.broken": caseEntry("contacts.broken") } });
  testbook.syncCases({ featureName: "Leads", featureDescription: "d", suiteName: "s", suiteDescription: "d", entries: { "leads.create": caseEntry("leads.create") } });
  testbook.syncCases({ featureName: "Billing", featureDescription: "d", suiteName: "s", suiteDescription: "d", entries: { "billing.pay": caseEntry("billing.pay") } });
  for (const id of ["contacts.create", "contacts.edit", "leads.create", "billing.pay"]) testbook.setAutomationReadiness(id, "ready");
  testbook.setAutomationReadiness("contacts.broken", "quarantined", "known broken selector");
  const item = (semanticId, featureName, title, statement, relatedTests = []) => {
    const proposed = knowledge.proposeItem({ semanticId, type: "BUSINESS_RULE", featureName, featureDescription: "d", title, statement, provenance: "DOCUMENTED", relatedTests });
    return knowledge.approveItem(proposed.id, HUMAN);
  };
  const emailRule = item("BR-CONTACT-EMAIL-001", "Contacts", "Contact email format", "A contact email must be a valid address and unique per firm.", ["contacts.create"]);
  const phoneRule = item("BR-CONTACT-PHONE-001", "Contacts", "Contact phone format", "A contact phone number may include a country prefix.");
  const leadRule = item("BR-LEAD-SOURCE-001", "Leads", "Lead source", "A lead records where the enquiry came from.");
  item("BR-BILLING-PAY-001", "Billing", "Invoice payment", "An invoice is paid when the ledger balance reaches zero.", ["billing.pay"]);
  knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Leads", toFeatureName: "Contacts", rationale: "leads convert to contacts" });
  knowledge.approveEdge(knowledge.inboxEdges()[0].id, HUMAN);
  return { emailRule, phoneRule, leadRule };
}

const submit = (signals, over = {}) => signals.submit({ kind: "release_note", title: "Contact email rule tightened", body: "BR-CONTACT-EMAIL-001 now also rejects role addresses such as info@.", submittedBy: HUMAN, ...over });

// ---------- recording ----------

test("a signal is recorded with source and time; the same text is never recorded twice, whatever the label", () => {
  withApp(({ signals, db }) => {
    const first = submit(signals, { source: "Release 4.2 notes", sourceRef: "https://example.test/rel/42", occurredAt: "2026-09-01T10:00:00Z" });
    assert.equal(first.duplicate, false);
    assert.equal(first.source, "Release 4.2 notes");
    assert.equal(first.occurred_at, "2026-09-01T10:00:00.000Z");
    const again = submit(signals, { kind: "qa_note", title: "  CONTACT email rule tightened ", body: "br-contact-email-001 now also rejects   role addresses such as info@." });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM change_signals").get().n, 1);
  });
});

test("submission is validated: kind, submitter, empty text, size and dates", () => {
  withApp(({ signals }) => {
    for (const bad of [{ kind: "rumour" }, { submittedBy: "" }, { title: "  " }, { body: "" }, { title: "x".repeat(201) }, { body: "x".repeat(20001) }, { occurredAt: "not a date" }]) {
      assert.throws(() => submit(signals, bad), (e) => typeof e.code === "string" && e.code.startsWith("invalid_") || e.code === "no_submitter", JSON.stringify(bad).slice(0, 40));
    }
  });
});

test("credentials pasted into a signal are masked before anything is stored", () => {
  withApp(({ signals, db }) => {
    const signal = submit(signals, { title: "Login broke", body: "It fails when password=Tr0ub4dor&3-fake is typed. Bearer abcDEF1234567890xyzFAKE", sourceRef: "https://x.test/t?token=abcDEF1234567890" });
    const stored = JSON.stringify(db.prepare("SELECT * FROM change_signals").all());
    for (const secret of ["Tr0ub4dor", "abcDEF1234567890xyzFAKE", "abcDEF1234567890"]) assert.ok(!stored.includes(secret), `stored ${secret}`);
    assert.ok(!JSON.stringify(signal).includes("Tr0ub4dor"));
  });
});

// ---------- analysis ----------

test("a signal that cites a fact yields that fact, its linked test first, and a justified regression plan", () => {
  withApp((app) => {
    seed(app);
    const signal = app.signals.analyze(submit(app.signals).id);
    const { affectedFacts, regressionPlan } = signal.analysis;
    assert.equal(affectedFacts[0].semanticId, "BR-CONTACT-EMAIL-001");
    assert.equal(affectedFacts[0].basis, "cited");
    const run = regressionPlan.run;
    assert.equal(run[0].externalId, "contacts.create", "the test linked to the fact leads");
    assert.equal(run[0].reasons[0].basis, "linked_to_fact");
    assert.ok(run.every((entry) => entry.reasons.length && entry.reasons.every((r) => r.because)), "every entry says why it is there");
    assert.ok(run.some((entry) => entry.externalId === "contacts.edit"), "same-feature case included");
    assert.ok(run.some((entry) => entry.externalId === "leads.create" && entry.reasons.some((r) => r.basis === "graph_neighbor")), "an approved dependency pulls the neighbor in");
    assert.ok(!run.some((entry) => entry.externalId === "billing.pay"), "an unrelated feature is not dragged in");
    assert.equal(regressionPlan.blocked.length, 1);
    assert.equal(regressionPlan.blocked[0].externalId, "contacts.broken");
    assert.equal(regressionPlan.blocked[0].blockedReason, "quarantined");
  });
});

test("naming a feature (not a fact) pulls in that feature's facts and cases; loose word overlap is the weakest reason", () => {
  withApp((app) => {
    seed(app);
    const named = app.signals.analyze(submit(app.signals, { title: "Contacts form redesign", body: "The Contacts screen layout changes next release." }).id).analysis;
    assert.deepEqual(named.affectedFacts.map((f) => f.basis).sort(), ["feature_named", "feature_named"]);
    const loose = app.signals.analyze(submit(app.signals, { title: "Invoice thing", body: "Ledger balance zero payment invoice reconciliation." }).id).analysis;
    assert.equal(loose.affectedFacts[0].semanticId, "BR-BILLING-PAY-001");
    assert.equal(loose.affectedFacts[0].basis, "term_overlap");
    assert.ok(loose.affectedFacts[0].matchedTerms.length >= 3);
  });
});

test("an aliased fact ID in a signal resolves to the fact it aliases", () => {
  withApp((app) => {
    seed(app);
    app.knowledge.proposeItem({ semanticId: "BR-CONTACT-EMAIL-RENAMED-001", type: "BUSINESS_RULE", featureName: "Contacts", featureDescription: "d", title: "t", statement: "A contact email must be a valid address and unique per firm.", provenance: "DOCUMENTED" });
    const analysis = app.signals.analyze(submit(app.signals, { title: "x", body: "See BR-CONTACT-EMAIL-RENAMED-001 for details." }).id).analysis;
    assert.equal(analysis.affectedFacts[0].semanticId, "BR-CONTACT-EMAIL-001");
  });
});

test("a signal that matches nothing says so instead of guessing; a fact with no test is reported as a gap", () => {
  withApp((app) => {
    seed(app);
    const nothing = app.signals.analyze(submit(app.signals, { title: "Zzz", body: "Qqq wwww eeee." }).id).analysis;
    assert.equal(nothing.affectedFacts.length, 0);
    assert.equal(nothing.regressionPlan.run.length, 0);
    assert.match(nothing.missingInformation[0], /No known feature or approved fact matched/);
    const gap = app.signals.analyze(submit(app.signals, { title: "Phone", body: "BR-CONTACT-PHONE-001 changes." }).id).analysis;
    assert.ok(gap.missingInformation.some((m) => m.includes("BR-CONTACT-PHONE-001 has no test case linked")));
    // Facts only in scope because their feature was named are summarised, not listed one by one.
    const broad = app.signals.analyze(submit(app.signals, { title: "Contacts form redesign", body: "The Contacts screen layout changes next release." }).id).analysis;
    assert.deepEqual(broad.missingInformation, ['1 approved fact in "Contacts" has no linked test case.']);
  });
});

test("analysing never changes any fact, test, or test status", () => {
  withApp((app) => {
    seed(app);
    const snapshot = () => JSON.stringify([
      app.db.prepare("SELECT id,status,statement,version FROM knowledge_items ORDER BY id").all(),
      app.db.prepare("SELECT external_id,status,automation_readiness FROM test_cases ORDER BY external_id").all(),
    ]);
    const before = snapshot();
    app.signals.analyze(submit(app.signals).id);
    assert.equal(snapshot(), before);
  });
});

// ---------- the reviewable diff ----------

test("a proposed revision is PENDING, shows before and after, and leaves the approved fact untouched", () => {
  withApp((app) => {
    const { emailRule } = seed(app);
    const signal = submit(app.signals);
    const result = app.signals.proposeRevision({ signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "A contact email must be a valid, non-role address and unique per firm.", proposedBy: HUMAN });
    assert.equal(result.unchanged, false);
    assert.equal(result.item.status, "pending_review");
    assert.equal(result.item.version, 2);
    assert.equal(app.db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(emailRule.id).status, "approved");
    const diff = app.signals.diff(signal.id);
    assert.equal(diff.revisions[0].before, emailRule.statement);
    assert.match(diff.revisions[0].after, /non-role/);
    // Only a human approving it changes the trusted statement.
    assert.throws(() => app.knowledge.approveItem(result.item.id, "ai_extraction"));
    app.knowledge.approveItem(result.item.id, HUMAN);
    assert.equal(app.db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(emailRule.id).status, "superseded");
  });
});

test("a revision is refused when there is no approved fact, when it carries a credential, or when the signal is dismissed; an unchanged statement is reported", () => {
  withApp((app) => {
    const { emailRule } = seed(app);
    const signal = submit(app.signals);
    assert.throws(() => app.signals.proposeRevision({ signalId: signal.id, semanticId: "BR-NOPE-NOPE-001", statement: "x" }), (e) => e.code === "no_approved_fact");
    assert.throws(() => app.signals.proposeRevision({ signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "use password=hunter2secret here" }), (e) => e.code === "secret_in_statement");
    assert.throws(() => app.signals.proposeRevision({ signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "" }), (e) => e.code === "invalid_revision");
    assert.equal(app.signals.proposeRevision({ signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: emailRule.statement }).unchanged, true);
    app.signals.dismiss({ signalId: signal.id, actor: HUMAN });
    assert.throws(() => app.signals.proposeRevision({ signalId: signal.id, semanticId: "BR-CONTACT-EMAIL-001", statement: "y y y" }), (e) => e.code === "dismissed");
  });
});

// ---------- flags and propagation ----------

test("flagging needs a human and an approved fact; it does not change the fact; the plan surfaces it without blocking anything", () => {
  withApp((app) => {
    const { emailRule, phoneRule } = seed(app);
    const signal = submit(app.signals);
    assert.throws(() => app.signals.flagForReview({ signalId: signal.id, itemId: emailRule.id, actor: "ai_extraction" }));
    assert.throws(() => app.signals.flagForReview({ signalId: signal.id, itemId: emailRule.id }));
    const flag = app.signals.flagForReview({ signalId: signal.id, itemId: emailRule.id, note: "role addresses now rejected", actor: HUMAN });
    assert.equal(flag.status, "open");
    assert.equal(app.signals.flagForReview({ signalId: signal.id, itemId: emailRule.id, actor: HUMAN }).duplicate, true);
    assert.equal(app.db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(emailRule.id).status, "approved");
    assert.equal(app.knowledge.openReviewFlags([phoneRule.id]).length, 0);
    assert.equal(app.knowledge.openReviewFlags([emailRule.id]).length, 1);
    // planImpactedTest surfaces flags for the facts it uses, without changing its cells.
    const intent = "Update a contact custom field and check how it appears for existing/new Contact and Lead.";
    const customFieldRule = app.knowledge.proposeItem({ semanticId: "BR-CF-TYPE-001", type: "BUSINESS_RULE", featureName: "Contact Custom Fields", featureDescription: "d", title: "Field types", statement: "A custom field has a type.", provenance: "DOCUMENTED" });
    app.knowledge.approveItem(customFieldRule.id, HUMAN);
    const cellsBefore = JSON.stringify(planImpactedTest({ intent, knowledge: app.knowledge, testbook: app.testbook }).cells);
    assert.deepEqual(planImpactedTest({ intent, knowledge: app.knowledge, testbook: app.testbook }).reviewFlags, []);
    app.signals.flagForReview({ signalId: signal.id, itemId: customFieldRule.id, actor: HUMAN });
    const plan = planImpactedTest({ intent, knowledge: app.knowledge, testbook: app.testbook });
    assert.equal(plan.reviewFlags.length, 1);
    assert.equal(plan.reviewFlags[0].semantic_id, "BR-CF-TYPE-001");
    assert.equal(JSON.stringify(plan.cells), cellsBefore, "a flag does not change what the plan runs");
    assert.equal(planImpactedTest({ intent: "unrelated", knowledge: app.knowledge, testbook: app.testbook }).reviewFlags.length, 0);
  });
});

test("resolving a flag needs a human and a valid resolution, works once, and closes the flag", () => {
  withApp((app) => {
    const { emailRule } = seed(app);
    const signal = submit(app.signals);
    const flag = app.signals.flagForReview({ signalId: signal.id, itemId: emailRule.id, actor: HUMAN });
    assert.throws(() => app.signals.resolveFlag({ flagId: flag.id, resolution: "still_valid", actor: "runner" }));
    assert.throws(() => app.signals.resolveFlag({ flagId: flag.id, resolution: "maybe", actor: HUMAN }), (e) => e.code === "invalid_resolution");
    assert.equal(app.signals.resolveFlag({ flagId: flag.id, resolution: "still_valid", note: "checked", actor: HUMAN }).status, "resolved");
    assert.equal(app.knowledge.openReviewFlags().length, 0);
    assert.throws(() => app.signals.resolveFlag({ flagId: flag.id, resolution: "revised", actor: HUMAN }), (e) => e.code === "not_open");
  });
});

test("a pending or rejected fact cannot be flagged", () => {
  withApp((app) => {
    seed(app);
    const pending = app.knowledge.proposeItem({ semanticId: "BR-PENDING-THING-001", type: "BUSINESS_RULE", featureName: "Contacts", featureDescription: "d", title: "t", statement: "Something pending.", provenance: "DOCUMENTED" });
    assert.throws(() => app.signals.flagForReview({ signalId: submit(app.signals).id, itemId: pending.id, actor: HUMAN }), (e) => e.code === "not_approved");
  });
});

// ---------- dismissal, listing, staleness ----------

test("dismissing needs a human; a dismissed signal cannot be analysed; listing reports counts", () => {
  withApp((app) => {
    seed(app);
    const signal = submit(app.signals);
    assert.throws(() => app.signals.dismiss({ signalId: signal.id, actor: "runner" }));
    app.signals.analyze(signal.id);
    const listed = app.signals.list();
    assert.equal(listed[0].affectedFacts >= 1, true);
    assert.equal(listed[0].status, "analyzed");
    app.signals.dismiss({ signalId: signal.id, note: "not relevant", actor: HUMAN });
    assert.equal(app.signals.list({ status: "dismissed" }).length, 1);
    assert.throws(() => app.signals.analyze(signal.id), (e) => e.code === "dismissed");
    assert.throws(() => app.signals.get("00000000-0000-0000-0000-000000000000"), (e) => e.code === "not_found");
  });
});

test("staleFacts lists volatile approved facts not reviewed for a while, and facts past their end date; stable recent facts are not listed", () => {
  withApp((app) => {
    const { emailRule } = seed(app);
    const observed = app.knowledge.proposeItem({ semanticId: "ENV-TENANT-CONFIG-001", type: "ENVIRONMENT_RULE", featureName: "Contacts", featureDescription: "d", title: "Tenant config", statement: "The staging tenant has custom fields enabled.", provenance: "OBSERVED" });
    app.knowledge.approveItem(observed.id, HUMAN);
    const future = Date.now() + 200 * 86400000;
    const stale = app.signals.staleFacts({ olderThanDays: 90, nowMs: future });
    assert.deepEqual(stale.map((f) => f.semanticId), ["ENV-TENANT-CONFIG-001"], "the documented, unscoped fact is stable");
    assert.match(stale[0].reasons[0], /not reviewed for/);
    assert.equal(app.signals.staleFacts({ olderThanDays: 90 }).length, 0, "nothing is stale today");
    app.db.prepare("UPDATE knowledge_items SET effective_until=? WHERE id=?").run("2020-01-01", emailRule.id);
    assert.ok(app.signals.staleFacts({}).some((f) => f.semanticId === "BR-CONTACT-EMAIL-001" && f.reasons.includes("past its end date")));
  });
});

test("the migration is recorded and the HTTP routes are wired to a human actor", () => {
  withApp(({ db }) => {
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=22").get());
    for (const table of ["change_signals", "change_signal_items", "knowledge_review_flags"]) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table), table);
  });
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(index, /changeSignals\.flagForReview\(\{ signalId: hit\[1\], \.\.\.input, actor: approverIdentity \}\)/);
  assert.match(index, /changeSignals\.resolveFlag\(\{ flagId: hit\[1\], \.\.\.input, actor: approverIdentity \}\)/);
  assert.match(index, /changeSignals\.dismiss\(\{ signalId: hit\[1\], \.\.\.input, actor: approverIdentity \}\)/);
});
