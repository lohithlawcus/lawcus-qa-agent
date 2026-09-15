import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import {
  openEnvironmentAdapter,
  EnvironmentAdapterError,
  STAGING,
  API_ORIGIN,
  ASSETS,
} from "../core/environment-adapter.mjs";
import { STAGING as LR_STAGING, API_ORIGIN as LR_API_ORIGIN, ASSETS as LR_ASSETS } from "../core/live-runner.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-env-adapter-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openEnvironmentAdapter(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("live-runner.mjs re-exports the exact same origins environment-adapter.mjs owns (single source of truth, section 20)", () => {
  assert.equal(LR_STAGING, STAGING);
  assert.equal(LR_API_ORIGIN, API_ORIGIN);
  assert.equal(LR_ASSETS, ASSETS);
});

test("resolveApprovedAdapter fails closed until a human approves", () => {
  withStore((adapters) => {
    assert.throws(
      () => adapters.resolveApprovedAdapter("lawcus"),
      (e) => e instanceof EnvironmentAdapterError && e.code === "no_approved_adapter",
    );
    const proposed = adapters.proposeAdapter({
      environmentId: "lawcus",
      apiOrigin: API_ORIGIN,
      appOrigin: STAGING,
      assetsOrigin: ASSETS,
    });
    assert.equal(proposed.status, "pending_review");
    assert.throws(() => adapters.resolveApprovedAdapter("lawcus"));
    adapters.approveAdapter(proposed.id, "operator:test");
    const resolved = adapters.resolveApprovedAdapter("lawcus");
    assert.equal(resolved.api_origin, API_ORIGIN);
  });
});

test("approving a new version supersedes the previously approved version", () => {
  withStore((adapters) => {
    const v1 = adapters.proposeAdapter({ environmentId: "lawcus", apiOrigin: API_ORIGIN, appOrigin: STAGING });
    adapters.approveAdapter(v1.id, "operator:test");
    const v2 = adapters.proposeAdapter({ environmentId: "lawcus", apiOrigin: API_ORIGIN, appOrigin: STAGING, assetsOrigin: ASSETS });
    adapters.approveAdapter(v2.id, "operator:test");
    const resolved = adapters.resolveApprovedAdapter("lawcus");
    assert.equal(resolved.version, 2);
    assert.equal(adapters.approved().length, 1);
  });
});

test("only a human approver may approve or reject", () => {
  withStore((adapters) => {
    const v1 = adapters.proposeAdapter({ environmentId: "lawcus", apiOrigin: API_ORIGIN, appOrigin: STAGING });
    assert.throws(
      () => adapters.approveAdapter(v1.id, "runner"),
      (e) => e instanceof EnvironmentAdapterError && e.code === "non_human_approver",
    );
  });
});
