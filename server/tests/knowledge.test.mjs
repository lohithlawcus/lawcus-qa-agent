import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openKnowledge, KnowledgeError } from "../core/knowledge.mjs";
import { seedLawcusKnowledge } from "../knowledge/lawcus-seed.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { loginTestCases } from "../core/runner.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-knowledge-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openKnowledge(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE_ITEM = {
  semanticId: "BR-SAMPLE-RULE-001",
  type: "BUSINESS_RULE",
  featureName: "Sample Feature",
  featureDescription: "d",
  title: "Sample rule",
  statement: "The sample rule statement.",
  provenance: "DOCUMENTED",
};

test("proposeItem creates a pending_review item, version 1, and the feature if needed", () => {
  withStore((knowledge) => {
    const item = knowledge.proposeItem(BASE_ITEM);
    assert.equal(item.status, "pending_review");
    assert.equal(item.version, 1);
    assert.equal(item.supersedes, null);
    const feature = knowledge.inboxItems()[0];
    assert.equal(feature.feature_name, "Sample Feature");
  });
});

test("proposing the exact same statement again is a no-op (no duplicate version)", () => {
  withStore((knowledge) => {
    knowledge.proposeItem(BASE_ITEM);
    knowledge.proposeItem(BASE_ITEM);
    knowledge.proposeItem(BASE_ITEM);
    assert.equal(knowledge.inboxItems().length, 1);
  });
});

test("proposing a changed statement for a known semantic_id appends a new version, never rewriting the old one", () => {
  withStore((knowledge, db) => {
    const v1 = knowledge.proposeItem(BASE_ITEM);
    const v2 = knowledge.proposeItem({ ...BASE_ITEM, statement: "A revised statement." });
    assert.equal(v2.version, 2);
    assert.equal(v2.supersedes, v1.id);
    const rows = db.prepare("SELECT version, statement FROM knowledge_items WHERE semantic_id=? ORDER BY version").all("BR-SAMPLE-RULE-001");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].statement, BASE_ITEM.statement);
    assert.equal(rows[1].statement, "A revised statement.");
  });
});

test("approveItem requires a human approver — AI/runner origins are refused", () => {
  withStore((knowledge) => {
    const item = knowledge.proposeItem(BASE_ITEM);
    assert.throws(
      () => knowledge.approveItem(item.id, "ai_extraction"),
      (e) => e instanceof KnowledgeError && e.code === "non_human_approver",
    );
    assert.throws(
      () => knowledge.approveItem(item.id, ""),
      (e) => e instanceof KnowledgeError && e.code === "no_approver",
    );
  });
});

test("approving a new version supersedes the previously approved version of the same semantic_id", () => {
  withStore((knowledge) => {
    const v1 = knowledge.proposeItem(BASE_ITEM);
    knowledge.approveItem(v1.id, "operator:test");
    const v2 = knowledge.proposeItem({ ...BASE_ITEM, statement: "A revised statement." });
    knowledge.approveItem(v2.id, "operator:test");
    const items = knowledge.approvedByFeature();
    const rows = items.find((f) => f.feature === "Sample Feature").items;
    assert.equal(rows.length, 1); // only the current approved version shows
    assert.equal(rows[0].version, 2);
  });
});

test("rejecting an item leaves it rejected, not approved, and cannot be decided twice", () => {
  withStore((knowledge) => {
    const item = knowledge.proposeItem(BASE_ITEM);
    knowledge.rejectItem(item.id, "operator:test", "Not accurate for our firm.");
    assert.throws(
      () => knowledge.approveItem(item.id, "operator:test"),
      (e) => e instanceof KnowledgeError && e.code === "not_pending",
    );
    assert.equal(knowledge.approvedByFeature().length, 0);
  });
});

test("proposeEdge requires both features to already exist and is idempotent on (type, from, to)", () => {
  withStore((knowledge) => {
    assert.throws(
      () =>
        knowledge.proposeEdge({
          type: "DEPENDS_ON",
          fromFeatureName: "Unknown A",
          toFeatureName: "Unknown B",
          rationale: "r",
        }),
      (e) => e instanceof KnowledgeError && e.code === "unknown_feature",
    );
    knowledge.ensureFeature("Feature A", "d");
    knowledge.ensureFeature("Feature B", "d");
    knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Feature A", toFeatureName: "Feature B", rationale: "r1" });
    knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Feature A", toFeatureName: "Feature B", rationale: "r2 (ignored)" });
    assert.equal(knowledge.inboxEdges().length, 1);
    assert.equal(knowledge.inboxEdges()[0].rationale, "r1");
  });
});

test("approvedGraph only ever returns approved edges — pending/rejected edges never affect it (section 9)", () => {
  withStore((knowledge) => {
    knowledge.ensureFeature("Feature A", "d");
    knowledge.ensureFeature("Feature B", "d");
    knowledge.ensureFeature("Feature C", "d");
    const edgeAB = knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Feature A", toFeatureName: "Feature B", rationale: "r" });
    knowledge.proposeEdge({ type: "DEPENDS_ON", fromFeatureName: "Feature A", toFeatureName: "Feature C", rationale: "r" });
    assert.equal(knowledge.approvedGraph().length, 0);
    knowledge.approveEdge(edgeAB.id, "operator:test");
    const graph = knowledge.approvedGraph();
    assert.equal(graph.length, 1);
    assert.equal(graph[0].from_feature, "Feature A");
    assert.equal(graph[0].to_feature, "Feature B");
  });
});

test("proposeItem enforces the type's naming-convention prefix (guide section 30) and gives a clear error", () => {
  withStore((knowledge) => {
    assert.throws(
      () => knowledge.proposeItem({ ...BASE_ITEM, semanticId: "contacts.person-or-company" }),
      (e) => e instanceof KnowledgeError && e.code === "invalid_semantic_id",
    );
    assert.throws(
      () => knowledge.proposeItem({ ...BASE_ITEM, semanticId: "DEP-CF-LEAD-001" }), // wrong prefix for BUSINESS_RULE
      (e) => e instanceof KnowledgeError && e.code === "invalid_semantic_id",
    );
    assert.throws(
      () => knowledge.proposeItem({ ...BASE_ITEM, semanticId: "BR-CF-RENAME" }), // missing sequence number
      (e) => e instanceof KnowledgeError && e.code === "invalid_semantic_id",
    );
    assert.throws(
      () => knowledge.proposeItem({ ...BASE_ITEM, type: "NOT_A_REAL_TYPE" }),
      (e) => e instanceof KnowledgeError && e.code === "unknown_type",
    );
    // FEATURE records are exempt from the trailing sequence number — one
    // feature is one canonical slug, not a series of atomic facts.
    const feature = knowledge.proposeItem({
      ...BASE_ITEM, type: "FEATURE", semanticId: "FEATURE-SAMPLE",
    });
    assert.equal(feature.semantic_id, "FEATURE-SAMPLE");
  });
});

test("proposeItem round-trips applies_to/preconditions/expected_behavior/effective_from/release as structured data, not opaque strings", () => {
  withStore((knowledge) => {
    knowledge.proposeItem({
      ...BASE_ITEM,
      appliesTo: ["contact", "lead"],
      preconditions: ["Custom field already exists"],
      expectedBehavior: {
        existing_contact: { field_name: "updated", field_value: "preserved" },
        new_contact: { field_name: "updated" },
      },
      effectiveFrom: "2026-09",
      release: "2026-09",
    });
    const item = knowledge.inboxItems()[0];
    assert.deepEqual(item.applies_to, ["contact", "lead"]);
    assert.deepEqual(item.preconditions, ["Custom field already exists"]);
    assert.deepEqual(item.expected_behavior.existing_contact, { field_name: "updated", field_value: "preserved" });
    assert.equal(item.effective_from, "2026-09");
    assert.equal(item.release, "2026-09");
  });
});

test("proposeItem with none of the optional structured fields leaves them null, not '[]' or '{}' placeholders", () => {
  withStore((knowledge) => {
    knowledge.proposeItem(BASE_ITEM);
    const item = knowledge.inboxItems()[0];
    assert.equal(item.applies_to, null);
    assert.equal(item.preconditions, null);
    assert.equal(item.expected_behavior, null);
    assert.equal(item.effective_from, null);
  });
});

test("linkApiContract/linkTest attach real evidence to a Knowledge item; itemLinks reads it back, idempotently", () => {
  withStore((knowledge, db) => {
    const item = knowledge.proposeItem(BASE_ITEM);
    // A real test_cases row for the FK linkTest relies on.
    const featureId = db.prepare("SELECT id FROM features WHERE name=?").get("Sample Feature").id;
    db.prepare("INSERT INTO test_suites(id,feature_id,name,description,created_at) VALUES(?,?,?,?,?)")
      .run("suite-1", featureId, "Sample Suite", "d", new Date().toISOString());
    db.prepare(
      "INSERT INTO test_cases(id,suite_id,external_id,title,description,layer,priority,risk,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run("case-1", "suite-1", "TC-SAMPLE-001", "t", "d", "ui", "normal", "normal", "approved", new Date().toISOString());

    knowledge.linkApiContract(item.id, "lawcus.contacts.update");
    knowledge.linkApiContract(item.id, "lawcus.contacts.update"); // idempotent
    knowledge.linkTest(item.id, "TC-SAMPLE-001");

    const links = knowledge.itemLinks(item.id);
    assert.deepEqual(links.apiContracts, ["lawcus.contacts.update"]);
    assert.deepEqual(links.relatedTests, ["TC-SAMPLE-001"]);

    const fromInbox = knowledge.inboxItems()[0];
    assert.deepEqual(fromInbox.api_contracts, ["lawcus.contacts.update"]);
    assert.deepEqual(fromInbox.related_tests, ["TC-SAMPLE-001"]);
  });
});

test("linkTest refuses a test_case_external_id that doesn't really exist (real FK, not a soft check)", () => {
  withStore((knowledge) => {
    const item = knowledge.proposeItem(BASE_ITEM);
    assert.throws(() => knowledge.linkTest(item.id, "TC-DOES-NOT-EXIST"));
  });
});

test("the real Lawcus seed proposes a substantial, deduplicated, correctly-sourced batch, none of it approved", () => {
  withStore((knowledge, db) => {
    // Real server startup syncs the Authentication TestBook cases before
    // seeding Knowledge (server/index.mjs), because the Authentication
    // items below cite them as related_tests via a real FK — mirror that
    // exact order here rather than seeding Knowledge in isolation.
    const testbook = openTestBook(db, null);
    testbook.syncCases({
      featureName: "Authentication",
      featureDescription: "Sign in, sign out, and session behavior for the Lawcus workspace.",
      suiteName: "login-essentials",
      suiteDescription: "The five bounded login checks currently automated against the local fixture.",
      priority: "normal",
      entries: loginTestCases,
    });
    seedLawcusKnowledge(knowledge);
    const pending = knowledge.inboxItems();
    assert.ok(pending.length >= 25, `expected a substantial batch, got ${pending.length}`);
    assert.equal(knowledge.approvedByFeature().length, 0);
    // Authentication items are self-sourced (verified in this project);
    // Contacts/Leads/Custom Fields items must all cite a real source URL.
    for (const item of pending) {
      if (item.feature_name === "Authentication") continue;
      assert.ok(item.source_id, `${item.semantic_id} should cite a source`);
      const source = db.prepare("SELECT * FROM knowledge_sources WHERE id=?").get(item.source_id);
      assert.match(source.url, /^https:\/\/support\.lawcus\.com\//, item.semantic_id);
    }
    seedLawcusKnowledge(knowledge); // idempotency against the real dataset
    assert.equal(knowledge.inboxItems().length, pending.length);
  });
});
