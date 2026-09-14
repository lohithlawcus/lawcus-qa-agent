import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { openProposals, ProposalError } from "../core/proposals.mjs";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    readFileSync(new URL("../migrations/004_proposals.sql", import.meta.url), "utf8"),
  );
  return db;
}

function harness() {
  const db = freshDb();
  const events = [];
  const proposals = openProposals(db, (kind, id, data) =>
    events.push({ kind, id, data }),
  );
  const locator = {
    type: "LOCATOR_REPAIR",
    summary: "Sign-in button label changed",
    trigger: "locator_not_found during run",
    subjectKind: "locator",
    subjectId: "login.submit",
    proposedValue: "Sign in to workspace",
    generatedBy: "runner",
    risk: "medium",
  };
  return { db, events, proposals, locator };
}

test("Step 1: a candidate locator creates a proposal and never touches the trusted path", () => {
  const { proposals, locator } = harness();
  proposals.create(locator);
  assert.equal(
    proposals.readTrusted("locator", "login.submit"),
    undefined,
    "the trusted locator must remain unchanged until a human approves",
  );
  assert.equal(proposals.inbox().length, 1);
  assert.equal(proposals.inbox()[0].status, "pending_review");
});

test("section 14: the runner that generated a proposal cannot approve it", () => {
  const { proposals, locator } = harness();
  const id = proposals.create(locator);
  assert.throws(
    () => proposals.approve(id, "runner"),
    (e) => e instanceof ProposalError && e.code === "non_human_approver",
  );
});

test("section 14: AI, recorder and network observer can never approve", () => {
  const { proposals, locator } = harness();
  for (const actor of ["ai_planner", "recorder", "network_observer"]) {
    const id = proposals.create({ ...locator, subjectId: `login.${actor}` });
    assert.throws(
      () => proposals.approve(id, actor),
      (e) => e.code === "non_human_approver",
      `${actor} must not be able to approve`,
    );
  }
});

test("an operator approval promotes the value and bumps the trusted version", () => {
  const { proposals, locator, events } = harness();
  const id = proposals.create(locator);
  const result = proposals.approve(id, "operator:lohith", "verified manually");
  assert.equal(result.version, 1);
  const trusted = proposals.readTrusted("locator", "login.submit");
  assert.equal(trusted.value, "Sign in to workspace");
  assert.equal(trusted.version, 1);
  assert.equal(proposals.get(id).status, "approved");
  assert.ok(events.some((e) => e.kind === "proposal.approved"));
});

test("section 14: a stale proposal cannot modify a newer trusted version", () => {
  const { proposals, locator } = harness();
  const first = proposals.create(locator);
  const second = proposals.create({
    ...locator,
    proposedValue: "Log in",
    summary: "Competing candidate",
  });
  proposals.approve(first, "operator:lohith");
  // `second` was computed against base_version 0; trusted is now version 1.
  assert.throws(
    () => proposals.approve(second, "operator:lohith"),
    (e) => e.code === "stale" || e.code === "not_pending",
  );
  assert.equal(
    proposals.readTrusted("locator", "login.submit").value,
    "Sign in to workspace",
    "the stale proposal must not overwrite the newer trusted value",
  );
});

test("approving one proposal supersedes competing pending proposals for the same subject", () => {
  const { proposals, locator } = harness();
  proposals.create({ ...locator, proposedValue: "Log in" });
  const chosen = proposals.create({ ...locator, proposedValue: "Sign in now" });
  proposals.approve(chosen, "operator:lohith");
  assert.equal(proposals.inbox("pending_review").length, 0);
  assert.equal(proposals.inbox("superseded").length, 1);
});

test("an expired proposal cannot be approved", () => {
  const { proposals, locator } = harness();
  const id = proposals.create({ ...locator, ttlHours: -1 });
  assert.throws(
    () => proposals.approve(id, "operator:lohith"),
    (e) => e.code === "expired",
  );
  assert.equal(proposals.get(id).status, "expired");
  assert.equal(proposals.readTrusted("locator", "login.submit"), undefined);
});

test("unknown proposal types and no-op proposals are refused", () => {
  const { proposals, locator } = harness();
  assert.throws(
    () => proposals.create({ ...locator, type: "AUTO_FIX" }),
    (e) => e.code === "unknown_type",
  );
  const id = proposals.create(locator);
  proposals.approve(id, "operator:lohith");
  assert.throws(
    () => proposals.create(locator),
    (e) => e.code === "no_change",
  );
});

test("every decision is audited with its approver", () => {
  const { proposals, locator, events } = harness();
  const a = proposals.create(locator);
  proposals.reject(a, "operator:lohith", "label change looks like a real defect");
  const rejected = events.find((e) => e.kind === "proposal.rejected");
  assert.equal(rejected.data.approver, "operator:lohith");
  assert.equal(proposals.get(a).status, "rejected");
});
