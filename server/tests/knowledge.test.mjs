import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openKnowledge, KnowledgeError } from "../core/knowledge.mjs";
import { seedLawcusKnowledge } from "../knowledge/lawcus-seed.mjs";

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
  semanticId: "sample.rule",
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
    const rows = db.prepare("SELECT version, statement FROM knowledge_items WHERE semantic_id=? ORDER BY version").all("sample.rule");
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

test("the real Lawcus seed proposes a substantial, deduplicated, correctly-sourced batch, none of it approved", () => {
  withStore((knowledge, db) => {
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
