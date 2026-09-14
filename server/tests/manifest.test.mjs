import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { loginTestCases } from "../core/runner.mjs";
import { buildRunManifest, ManifestError } from "../core/manifest.mjs";

const testCases = Object.fromEntries(
  Object.entries(loginTestCases).map(([key, entry]) => [key, entry.definition]),
);

function withSyncedTestbook(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-manifest-"));
  try {
    const { db, audit } = openStore(dir);
    const testbook = openTestBook(db, audit);
    testbook.syncCases({
      featureName: "Authentication",
      featureDescription: "d",
      suiteName: "login-essentials",
      suiteDescription: "d",
      entries: loginTestCases,
    });
    return fn(testbook, db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildRunManifest resolves the exact test case/version for every scenario", () => {
  withSyncedTestbook((testbook) => {
    const manifest = buildRunManifest({
      testbook,
      testCases,
      scenarios: ["valid_login", "logout"],
      environmentId: "fixture",
      requestedIntent: "Test the login page.",
      requester: "operator:test",
      triggerSource: "operator-run",
    });
    assert.equal(manifest.version, 1);
    assert.equal(manifest.environmentId, "fixture");
    assert.equal(manifest.requester, "operator:test");
    assert.equal(manifest.testCases.length, 2);
    const valid = manifest.testCases.find((c) => c.scenario === "valid_login");
    assert.equal(valid.externalId, "auth.valid_login");
    assert.equal(valid.version, 1);
    assert.ok(valid.testCaseId);
    assert.ok(valid.versionId);
  });
});

test("buildRunManifest captures the deduplicated, exact set of primitives the scenarios use", () => {
  withSyncedTestbook((testbook) => {
    const manifest = buildRunManifest({
      testbook,
      testCases,
      scenarios: ["password_masked"], // uses only open_login_page + ensure_login_fields + assert_password_masked
      environmentId: "fixture",
      requestedIntent: "x",
      requester: "operator:test",
      triggerSource: "operator-run",
    });
    const ids = manifest.primitives.map((p) => p.id).sort();
    assert.deepEqual(ids, [
      "auth.assert_password_masked",
      "auth.ensure_login_fields",
      "auth.open_login_page",
    ]);
    for (const p of manifest.primitives) assert.equal(typeof p.version, "number");
  });
});

test("buildRunManifest fails closed when a scenario's case isn't synced into the TestBook yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-manifest-unsynced-"));
  try {
    const { db, audit } = openStore(dir);
    const testbook = openTestBook(db, audit); // never synced
    assert.throws(
      () =>
        buildRunManifest({
          testbook,
          testCases,
          scenarios: ["valid_login"],
          environmentId: "fixture",
          requestedIntent: "x",
          requester: "operator:test",
          triggerSource: "operator-run",
        }),
      (e) => e instanceof ManifestError && e.code === "case_not_in_testbook",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRunManifest fails closed when a scenario's DSL references an unknown primitive", () => {
  withSyncedTestbook((testbook) => {
    const tampered = {
      ...testCases,
      valid_login: {
        ...testCases.valid_login,
        steps: [
          ...testCases.valid_login.steps,
          { primitive: "auth.does_not_exist", input: {} },
        ],
      },
    };
    assert.throws(
      () =>
        buildRunManifest({
          testbook,
          testCases: tampered,
          scenarios: ["valid_login"],
          environmentId: "fixture",
          requestedIntent: "x",
          requester: "operator:test",
          triggerSource: "operator-run",
        }),
      (e) => e instanceof ManifestError && e.code === "primitive_not_trusted",
    );
  });
});

test("runnerRevision either resolves a real git revision or degrades to null, never throws", () => {
  withSyncedTestbook((testbook) => {
    const manifest = buildRunManifest({
      testbook,
      testCases,
      scenarios: ["password_masked"],
      environmentId: "fixture",
      requestedIntent: "x",
      requester: "operator:test",
      triggerSource: "operator-run",
    });
    assert.ok(
      manifest.runnerRevision === null || typeof manifest.runnerRevision === "string",
    );
  });
});
