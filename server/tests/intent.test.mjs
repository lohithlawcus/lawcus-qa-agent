import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openTestBook } from "../core/testbook.mjs";
import { loginTestCases } from "../core/runner.mjs";
import { normalizeIntent, resolveIntent } from "../core/intent.mjs";

function withSyncedTestbook(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-intent-"));
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
    return fn(testbook);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("normalizeIntent trims and collapses whitespace, nothing else", () => {
  assert.equal(normalizeIntent("  Test   the login  page.  "), "Test the login page.");
});

test("known login phrasing resolves locally for the fixture environment with all 5 scenarios", () => {
  withSyncedTestbook((testbook) => {
    for (const intent of [
      "Test the login page.",
      "Thoroughly test login.",
      "Regression test login",
      "  retest sign in again  ",
    ]) {
      const routed = resolveIntent({ intent, testbook, environmentId: "fixture" });
      assert.equal(routed.matched, true, intent);
      assert.equal(routed.confidence, 1);
      assert.deepEqual(
        routed.scenarios.sort(),
        ["empty_fields", "invalid_password", "logout", "password_masked", "valid_login"],
      );
      assert.ok(routed.featureId);
      assert.ok(routed.suiteId);
      assert.equal(routed.caseIds.length, 5);
    }
  });
});

test("known login phrasing resolves locally for lawcus but excludes invalid_password (account lockout policy)", () => {
  withSyncedTestbook((testbook) => {
    const routed = resolveIntent({
      intent: "Test the login page.",
      testbook,
      environmentId: "lawcus",
    });
    assert.equal(routed.matched, true);
    assert.deepEqual(
      routed.scenarios.sort(),
      ["empty_fields", "logout", "password_masked", "valid_login"],
    );
    assert.equal(routed.caseIds.length, 4);
    // The exclusion is a deliberate environment policy, not a coverage
    // gap, so it still resolves with full confidence.
    assert.equal(routed.confidence, 1);
  });
});

test("an unrecognized intent does not match, regardless of TestBook state", () => {
  withSyncedTestbook((testbook) => {
    for (const intent of [
      "Test billing",
      "Test login and delete all users",
      "Please test the contacts page",
      "",
    ]) {
      const routed = resolveIntent({ intent, testbook, environmentId: "fixture" });
      assert.equal(routed.matched, false, intent);
      assert.equal(routed.confidence, 0);
      assert.equal(routed.featureId, null);
      assert.equal(routed.suiteId, null);
      assert.deepEqual(routed.caseIds, []);
      assert.deepEqual(routed.scenarios, []);
    }
  });
});

test("known phrasing falls through (does not match) when the TestBook has no such suite yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-intent-unsynced-"));
  try {
    const { db, audit } = openStore(dir);
    const testbook = openTestBook(db, audit); // never synced
    const routed = resolveIntent({
      intent: "Test the login page.",
      testbook,
      environmentId: "fixture",
    });
    assert.equal(routed.matched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveIntent always returns the normalized intent, matched or not", () => {
  withSyncedTestbook((testbook) => {
    const routed = resolveIntent({
      intent: "  Test billing  ",
      testbook,
      environmentId: "fixture",
    });
    assert.equal(routed.normalizedIntent, "Test billing");
  });
});
