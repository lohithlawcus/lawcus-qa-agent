import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../core/store.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openNetworkObservations } from "../core/network-observations.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-network-observations-"));
  try {
    const { db, audit } = openStore(dir);
    return fn({ db, audit, apiContracts: openApiContracts(db, audit), observations: openNetworkObservations(db, audit) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(db) {
  const runbookId = randomUUID();
  db.prepare("INSERT INTO runbooks VALUES(?,?,?,?,?,?,?,?)").run(
    runbookId, 1, "fixture", "t", "intent", "built-in", JSON.stringify({ scenarios: ["valid_login"] }), new Date().toISOString(),
  );
  const runId = randomUUID();
  db.prepare("INSERT INTO runs(id,runbook_id,status,replay,started_at) VALUES(?,?,?,?,?)").run(
    runId, runbookId, "running", 0, new Date().toISOString(),
  );
  return runId;
}

test("record stores a network observation and forRun retrieves it", () => {
  withStore(({ db, apiContracts, observations }) => {
    const runId = seedRun(db);
    const contract = apiContracts.proposeContract({
      semanticId: "sample.op",
      featureName: "Sample",
      featureDescription: "d",
      operation: "op",
      method: "POST",
      pathTemplate: "/login",
      responseSchema: { "200": { type: "object" } },
      expectedStatuses: [200],
      readWrite: "write",
      verificationRequirements: "n/a",
      provenance: "OBSERVED_API",
    });
    apiContracts.approveContract(contract.id, "operator:test");
    observations.record({
      runId,
      stepLabel: "valid_login",
      contractId: contract.id,
      semanticId: "sample.op",
      expectedCardinality: "exactly_one",
      result: {
        observedCount: 1,
        cardinalityOk: true,
        contractMatch: true,
        mismatchReason: null,
        matchResults: [{ requestSummary: { present: true, kind: "object", keys: ["email"] }, responseSummary: { present: false } }],
      },
    });
    const rows = observations.forRun(runId);
    assert.equal(rows.network.length, 1);
    assert.equal(rows.network[0].contract_match, 1);
    assert.deepEqual(JSON.parse(rows.network[0].request_summaries), [{ present: true, kind: "object", keys: ["email"] }]);
  });
});

test("recordConsoleEntries stores sanitized console/page error evidence", () => {
  withStore(({ db, observations }) => {
    const runId = seedRun(db);
    observations.recordConsoleEntries({
      runId,
      entries: [
        { level: "console-error", message: "TypeError: x is not a function" },
        { level: "page-error", message: "Uncaught ReferenceError" },
      ],
    });
    const rows = observations.forRun(runId);
    assert.equal(rows.console.length, 2);
    assert.deepEqual(rows.console.map((r) => r.level).sort(), ["console-error", "page-error"]);
  });
});
