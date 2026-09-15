import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openAuthoringSessions, AuthoringSessionError } from "../core/authoring-sessions.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-authoring-sessions-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openAuthoringSessions(db, audit));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = { operator: "operator:test", environmentId: "fixture", featureName: "Contacts", workflowDescription: "Edit a custom field" };

test("start creates an open session", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    assert.equal(session.status, "open");
    assert.equal(session.persona_id, null);
  });
});

test("recordAction never persists a literal value for a redacted action, regardless of what's passed", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    sessions.recordAction(session.id, {
      sequence: 0,
      actionType: "change",
      locatorCandidate: { strategy: "label", value: "Password" },
      locatorQuality: "stable",
      redacted: true,
      valueSummary: "redacted",
      valueLiteral: "this-should-never-be-stored",
    });
    const actions = sessions.actionsFor(session.id);
    assert.equal(actions[0].value_literal, null);
    assert.equal(actions[0].redacted, 1);
  });
});

test("recordAction stores the literal value for a non-redacted action", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    sessions.recordAction(session.id, {
      sequence: 0,
      actionType: "change",
      locatorCandidate: { strategy: "label", value: "First name" },
      locatorQuality: "stable",
      redacted: false,
      valueLiteral: "John",
    });
    assert.equal(sessions.actionsFor(session.id)[0].value_literal, "John");
  });
});

test("actionsFor returns actions in sequence order with locator_candidate parsed back to an object", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    sessions.recordAction(session.id, { sequence: 1, actionType: "click", locatorCandidate: { strategy: "text", value: "Save" }, locatorQuality: "stable", redacted: false });
    sessions.recordAction(session.id, { sequence: 0, actionType: "click", locatorCandidate: { strategy: "text", value: "Open" }, locatorQuality: "stable", redacted: false });
    const actions = sessions.actionsFor(session.id);
    assert.deepEqual(actions.map((a) => a.sequence), [0, 1]);
    assert.deepEqual(actions[0].locator_candidate, { strategy: "text", value: "Open" });
  });
});

test("recordNetworkObservation stores sanitized request/response summaries", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    sessions.recordNetworkObservation(session.id, {
      method: "POST",
      host: "api.example.test",
      path: "/contacts",
      status: 201,
      requestSummary: { present: true, kind: "object", keys: ["name"] },
      responseSummary: { present: true, kind: "object", keys: ["id"] },
    });
    const rows = sessions.networkObservationsFor(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 201);
    assert.deepEqual(JSON.parse(rows[0].request_summary), { present: true, kind: "object", keys: ["name"] });
  });
});

test("complete requires an open session and records the generated proposal ids", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    const completed = sessions.complete(session.id, { proposalIds: ["p1", "p2"] });
    assert.equal(completed.status, "completed");
    assert.deepEqual(JSON.parse(completed.proposal_ids), ["p1", "p2"]);
    assert.ok(completed.ended_at);
    assert.throws(
      () => sessions.complete(session.id, { proposalIds: [] }),
      (e) => e instanceof AuthoringSessionError && e.code === "not_open",
    );
  });
});

test("discard requires an open session and records a reason", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    const discarded = sessions.discard(session.id, "Operator changed their mind.");
    assert.equal(discarded.status, "discarded");
    assert.equal(discarded.discard_reason, "Operator changed their mind.");
    assert.throws(() => sessions.discard(session.id, "again"));
  });
});

test("fail marks a session failed without throwing even if called on something already closed", () => {
  withStore((sessions) => {
    const session = sessions.start(BASE);
    sessions.discard(session.id, "done");
    assert.doesNotThrow(() => sessions.fail(session.id, "browser crashed"));
    // Already discarded — fail() only affects 'open' rows, so status stays discarded.
    assert.equal(sessions.get(session.id).status, "discarded");
  });
});

test("list returns sessions most-recently-started first", () => {
  withStore((sessions) => {
    const a = sessions.start(BASE);
    const b = sessions.start({ ...BASE, featureName: "Leads" });
    const rows = sessions.list();
    assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);
  });
});
