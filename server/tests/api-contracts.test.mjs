import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openApiContracts, ApiContractError } from "../core/api-contracts.mjs";
import { seedLawcusApiContracts, AUTHENTICATION_CONTRACTS, CONTACTS_CONTRACTS, LEADS_CONTRACTS } from "../api-contracts/lawcus-seed.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-api-contracts-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openApiContracts(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = {
  semanticId: "sample.op",
  featureName: "Sample Feature",
  featureDescription: "d",
  operation: "Do a thing",
  method: "GET",
  pathTemplate: "/thing",
  responseSchema: { "200": { type: "object" } },
  expectedStatuses: [200],
  readWrite: "read",
  verificationRequirements: "Status must be read explicitly.",
  provenance: "OBSERVED_API",
};

test("proposeContract creates a pending_review contract at version 1", () => {
  withStore((contracts) => {
    const c = contracts.proposeContract(BASE);
    assert.equal(c.status, "pending_review");
    assert.equal(c.version, 1);
    assert.equal(c.supersedes, null);
  });
});

test("proposing the exact same contract again is a no-op (no duplicate version)", () => {
  withStore((contracts) => {
    contracts.proposeContract(BASE);
    contracts.proposeContract(BASE);
    assert.equal(contracts.inbox().length, 1);
  });
});

test("a changed contract appends a new version, never rewriting the old one", () => {
  withStore((contracts, db) => {
    const v1 = contracts.proposeContract(BASE);
    const v2 = contracts.proposeContract({ ...BASE, expectedStatuses: [200, 404] });
    assert.equal(v2.version, 2);
    assert.equal(v2.supersedes, v1.id);
    const rows = db.prepare("SELECT version FROM api_contracts WHERE semantic_id=? ORDER BY version").all("sample.op");
    assert.equal(rows.length, 2);
  });
});

test("approveContract requires a human approver — AI/observer origins are refused", () => {
  withStore((contracts) => {
    const c = contracts.proposeContract(BASE);
    assert.throws(
      () => contracts.approveContract(c.id, "network_observer"),
      (e) => e instanceof ApiContractError && e.code === "non_human_approver",
    );
  });
});

test("resolveApprovedContract fails closed until a human approves, then returns the parsed current version", () => {
  withStore((contracts) => {
    const c = contracts.proposeContract(BASE);
    assert.throws(
      () => contracts.resolveApprovedContract("sample.op"),
      (e) => e instanceof ApiContractError && e.code === "no_approved_contract",
    );
    contracts.approveContract(c.id, "operator:test");
    const resolved = contracts.resolveApprovedContract("sample.op");
    assert.deepEqual(resolved.expectedStatuses, [200]);
    assert.deepEqual(resolved.responseSchema, { "200": { type: "object" } });
  });
});

test("approving a new version supersedes the previously approved version", () => {
  withStore((contracts) => {
    const v1 = contracts.proposeContract(BASE);
    contracts.approveContract(v1.id, "operator:test");
    const v2 = contracts.proposeContract({ ...BASE, expectedStatuses: [200, 404] });
    contracts.approveContract(v2.id, "operator:test");
    assert.equal(contracts.resolveApprovedContract("sample.op").version, 2);
    const groups = contracts.approvedByFeature();
    const rows = groups.find((f) => f.feature === "Sample Feature").items;
    assert.equal(rows.length, 1);
  });
});

test("recordCall stores sanitized evidence and never touches the trusted contract on mismatch", () => {
  withStore((contracts) => {
    const v1 = contracts.proposeContract(BASE);
    contracts.approveContract(v1.id, "operator:test");
    contracts.recordCall({
      contractId: v1.id,
      environmentId: "lawcus",
      requestSummary: { method: "GET", host: "api.example.test", path: "/thing" },
      responseStatus: 500,
      responseSummary: { present: true, kind: "object", keys: ["error"] },
      contractMatch: false,
      mismatchReason: "Unexpected status 500",
      durationMs: 12,
    });
    const calls = contracts.recentCalls(v1.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].contract_match, 0);
    const stillApproved = contracts.resolveApprovedContract("sample.op");
    assert.equal(stillApproved.status, "approved");
    assert.equal(stillApproved.version, 1);
  });
});

test("the real Lawcus API seed proposes every contract as OBSERVED_API, unapproved, idempotently", () => {
  withStore((contracts) => {
    const expectedCount = AUTHENTICATION_CONTRACTS.length + CONTACTS_CONTRACTS.length + LEADS_CONTRACTS.length;
    seedLawcusApiContracts(contracts);
    const pending = contracts.inbox();
    assert.equal(pending.length, expectedCount);
    for (const c of pending) assert.equal(c.provenance, "OBSERVED_API");
    assert.equal(contracts.approvedByFeature().length, 0);
    seedLawcusApiContracts(contracts);
    assert.equal(contracts.inbox().length, expectedCount);
  });
});
