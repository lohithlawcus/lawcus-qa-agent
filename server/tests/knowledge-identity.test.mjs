import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openKnowledge, KnowledgeError } from "../core/knowledge.mjs";

process.env.QA_FORBID_LIVE = "1";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-kb-identity-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openKnowledge(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const item = (over = {}) => ({
  semanticId: "BR-SAMPLE-RULE-001", type: "BUSINESS_RULE", featureName: "Sample Feature", featureDescription: "d",
  title: "Sample rule", statement: "The sample rule statement.", provenance: "DOCUMENTED", ...over,
});
const count = (db, where = "1=1") => db.prepare(`SELECT COUNT(*) n FROM knowledge_items WHERE ${where}`).get().n;

test("the same statement proposed under a different ID returns the existing item and records the new ID as an alias", () => {
  withStore((kb, db) => {
    const first = kb.proposeItem(item());
    const again = kb.proposeItem(item({ semanticId: "BR-SAMPLE-RENAMED-001" }));
    assert.equal(again.id, first.id);
    assert.equal(count(db), 1);
    assert.equal(kb.resolveSemanticId("BR-SAMPLE-RENAMED-001").id, first.id, "the alias resolves to the original");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='knowledge.item.duplicate_suppressed'").get().n, 1);
  });
});

test("case, spacing and a trailing full stop do not make a statement different", () => {
  withStore((kb, db) => {
    kb.proposeItem(item());
    kb.proposeItem(item({ semanticId: "BR-SAMPLE-OTHER-001", statement: "  THE sample   rule statement  " }));
    assert.equal(count(db), 1);
  });
});

test("a duplicate of an APPROVED item and of a REJECTED item is suppressed too; a superseded one is not", () => {
  withStore((kb, db) => {
    const a = kb.proposeItem(item());
    kb.approveItem(a.id, "operator");
    kb.proposeItem(item({ semanticId: "BR-SAMPLE-COPY-001" }));
    const b = kb.proposeItem(item({ semanticId: "BR-SAMPLE-OTHER-002", statement: "A rejected statement." }));
    kb.rejectItem(b.id, "operator");
    kb.proposeItem(item({ semanticId: "BR-SAMPLE-OTHER-003", statement: "A rejected statement." }));
    assert.equal(count(db), 2, "nothing new was created for either duplicate");
    // supersede the approved one with a revised statement; the old statement may then be proposed again
    const v2 = kb.proposeItem(item({ statement: "The revised statement." }));
    kb.approveItem(v2.id, "operator");
    assert.equal(count(db, "status='superseded'"), 1);
    const back = kb.proposeItem(item({ semanticId: "BR-SAMPLE-BACK-001" }));
    assert.equal(back.status, "pending_review");
  });
});

test("the same statement in a DIFFERENT feature is a different fact", () => {
  withStore((kb, db) => {
    kb.proposeItem(item());
    kb.proposeItem(item({ semanticId: "BR-OTHER-RULE-001", featureName: "Other Feature" }));
    assert.equal(count(db), 2);
  });
});

test("proposing under an alias with a NEW statement is a revision of the original item", () => {
  withStore((kb, db) => {
    const first = kb.proposeItem(item());
    kb.proposeItem(item({ semanticId: "BR-SAMPLE-RENAMED-001" }));
    const revised = kb.proposeItem(item({ semanticId: "BR-SAMPLE-RENAMED-001", statement: "A changed statement." }));
    assert.equal(revised.semantic_id, "BR-SAMPLE-RULE-001");
    assert.equal(revised.version, 2);
    assert.equal(revised.supersedes, first.id);
  });
});

test("an unchanged re-proposal is still idempotent and an invalid ID is still refused", () => {
  withStore((kb, db) => {
    const a = kb.proposeItem(item());
    assert.equal(kb.proposeItem(item()).id, a.id);
    assert.equal(count(db), 1);
    assert.throws(() => kb.proposeItem(item({ semanticId: "not-valid" })), KnowledgeError);
  });
});

// ---------- collapsing duplicates that already exist ----------

function seedDuplicates(kb, db) {
  // Simulate the historical state: duplicates that got in under different IDs.
  const approved = kb.proposeItem(item());
  kb.approveItem(approved.id, "operator");
  const insert = (semanticId, statement, status, at) => {
    const id = crypto.randomUUID();
    const feature = db.prepare("SELECT feature_id FROM knowledge_items WHERE id=?").get(approved.id).feature_id;
    db.prepare(`INSERT INTO knowledge_items(id,semantic_id,version,type,feature_id,title,statement,provenance,status,created_at)
                VALUES(?,?,1,'BUSINESS_RULE',?,'t',?,'DOCUMENTED',?,?)`).run(id, semanticId, feature, statement, status, at);
    return id;
  };
  return {
    approved,
    dupOfApproved: insert("BR-SAMPLE-DUP-001", "the sample rule statement", "pending_review", "2026-01-02T00:00:00Z"),
    pendingKeeper: insert("BR-SAMPLE-P-001", "Pending twin.", "pending_review", "2026-01-03T00:00:00Z"),
    pendingLater: insert("BR-SAMPLE-P-002", "pending twin", "pending_review", "2026-01-04T00:00:00Z"),
    rejected: insert("BR-SAMPLE-R-001", "Was rejected.", "rejected", "2026-01-05T00:00:00Z"),
    dupOfRejected: insert("BR-SAMPLE-R-002", "Was rejected.", "pending_review", "2026-01-06T00:00:00Z"),
    unique: insert("BR-SAMPLE-U-001", "Only stated once.", "pending_review", "2026-01-07T00:00:00Z"),
  };
}
const statusOf = (db, id) => db.prepare("SELECT status FROM knowledge_items WHERE id=?").get(id).status;

test("collapseDuplicates defaults to a dry run that changes nothing and needs no approver", () => {
  withStore((kb, db) => {
    const ids = seedDuplicates(kb, db);
    const report = kb.collapseDuplicates();
    assert.equal(report.applied, false);
    assert.equal(report.wouldRetire, 3);
    assert.equal(statusOf(db, ids.dupOfApproved), "pending_review");
    assert.equal(statusOf(db, ids.pendingLater), "pending_review");
  });
});

test("applying needs a human approver; non-human and missing approvers are refused and nothing changes", () => {
  withStore((kb, db) => {
    const ids = seedDuplicates(kb, db);
    assert.throws(() => kb.collapseDuplicates({ apply: true }), (e) => e.code === "no_approver");
    assert.throws(() => kb.collapseDuplicates({ apply: true, approver: "ai_extraction" }), KnowledgeError);
    assert.equal(statusOf(db, ids.dupOfApproved), "pending_review");
  });
});

test("applying retires only the pending duplicates, keeps the earliest of a pending pair, and touches nothing else", () => {
  withStore((kb, db) => {
    const ids = seedDuplicates(kb, db);
    const report = kb.collapseDuplicates({ apply: true, approver: "operator" });
    assert.equal(report.retired, 3);
    assert.equal(statusOf(db, ids.dupOfApproved), "rejected");
    assert.equal(statusOf(db, ids.pendingLater), "rejected");
    assert.equal(statusOf(db, ids.dupOfRejected), "rejected");
    assert.equal(statusOf(db, ids.approved.id), "approved", "the approved item is untouched");
    assert.equal(statusOf(db, ids.pendingKeeper), "pending_review", "the earlier of a pending pair stays for review");
    assert.equal(statusOf(db, ids.rejected), "rejected");
    assert.equal(statusOf(db, ids.unique), "pending_review");
    const note = db.prepare("SELECT decision_note, decided_by FROM knowledge_items WHERE id=?").get(ids.dupOfApproved);
    assert.match(note.decision_note, /^Duplicate of BR-SAMPLE-RULE-001/);
    assert.equal(note.decided_by, "operator");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='knowledge.duplicates_collapsed'").get().n, 1);
  });
});

test("collapsing is repeatable: a second apply finds nothing", () => {
  withStore((kb, db) => {
    seedDuplicates(kb, db);
    kb.collapseDuplicates({ apply: true, approver: "operator" });
    const again = kb.collapseDuplicates({ apply: true, approver: "operator" });
    assert.equal(again.applied, false);
    assert.equal(again.wouldRetire, 0);
  });
});

test("the migration is recorded and the HTTP route is wired to a human approver", () => {
  withStore((kb, db) => {
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=21").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_item_aliases'").get());
  });
  const index = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(index, /knowledge\.collapseDuplicates\(\{ approver: approverIdentity, apply: input\.apply \}\)/);
});
