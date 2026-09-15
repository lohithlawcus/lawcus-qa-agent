import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openApiContracts } from "../core/api-contracts.mjs";
import { openEnvironmentAdapter } from "../core/environment-adapter.mjs";
import { openNetworkAuthority } from "../core/network-authority.mjs";
import { createSafeApiClient, ApiClientError } from "../core/api-client.mjs";

// These tests exercise every fail-closed gate the Safe API Executor must
// pass through BEFORE it ever opens a real network connection (section 22).
// None of them make a real HTTP call — egress.mjs's proxy only accepts
// public, DNS-resolved hosts (it would reject a local test server just as
// it would reject a private one), so — same as live-runner.mjs — the
// executor's actual successful network path is proven by a real live
// staging call, not a unit test against a fake server.

const CONTRACT = {
  semanticId: "sample.op",
  featureName: "Sample Feature",
  featureDescription: "d",
  operation: "Do a thing",
  method: "POST",
  pathTemplate: "/things/:id",
  requestSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
  responseSchema: { "200": { type: "object" } },
  expectedStatuses: [200],
  readWrite: "write",
  verificationRequirements: "n/a",
  provenance: "OBSERVED_API",
};

async function withFixtures(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-api-client-"));
  try {
    const { db, audit } = openStore(dir);
    const apiContracts = openApiContracts(db, audit);
    const environmentAdapter = openEnvironmentAdapter(db, audit);
    const networkAuthority = openNetworkAuthority(db, audit);
    const apiClient = createSafeApiClient({ environmentAdapter, networkAuthority, apiContracts });
    await fn({ apiContracts, environmentAdapter, networkAuthority, apiClient });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (e) => e instanceof ApiClientError && e.code === code);
}

test("execute fails closed with no approved contract at all", () => {
  return withFixtures(async ({ apiClient }) => {
    await expectCode(
      apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { value: "x" } }),
      "no_approved_contract",
    );
  });
});

test("execute fails closed with an approved contract but no approved Environment Adapter", () => {
  return withFixtures(async ({ apiContracts, apiClient }) => {
    const c = apiContracts.proposeContract(CONTRACT);
    apiContracts.approveContract(c.id, "operator:test");
    await expectCode(
      apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { value: "x" } }),
      "no_approved_adapter",
    );
  });
});

test("execute fails closed with contract + adapter but no approved Network Authority", () => {
  return withFixtures(async ({ apiContracts, environmentAdapter, apiClient }) => {
    const c = apiContracts.proposeContract(CONTRACT);
    apiContracts.approveContract(c.id, "operator:test");
    const a = environmentAdapter.proposeAdapter({ environmentId: "lawcus", apiOrigin: "https://api.example.test", appOrigin: "https://example.test" });
    environmentAdapter.approveAdapter(a.id, "operator:test");
    await expectCode(
      apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { value: "x" } }),
      "no_approved_authority",
    );
  });
});

function approveAll({ apiContracts, environmentAdapter, networkAuthority }, { apiOrigin = "https://api.example.test", allowedHosts = ["api.example.test"], allowedMethods = ["POST"] } = {}) {
  const c = apiContracts.proposeContract(CONTRACT);
  apiContracts.approveContract(c.id, "operator:test");
  const a = environmentAdapter.proposeAdapter({ environmentId: "lawcus", apiOrigin, appOrigin: "https://example.test" });
  environmentAdapter.approveAdapter(a.id, "operator:test");
  const n = networkAuthority.proposeAuthority({ environmentId: "lawcus", allowedHosts, allowedMethods });
  networkAuthority.approveAuthority(n.id, "operator:test");
}

test("execute blocks a method the Network Authority does not permit", () => {
  return withFixtures(async (mods) => {
    approveAll(mods, { allowedMethods: ["GET"] });
    await expectCode(
      mods.apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { value: "x" } }),
      "method_not_authorized",
    );
  });
});

test("execute requires https (TLS) on the adapter's API origin", () => {
  return withFixtures(async (mods) => {
    approveAll(mods, { apiOrigin: "http://api.example.test" });
    await expectCode(
      mods.apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { value: "x" } }),
      "tls_required",
    );
  });
});

test("execute blocks a host the Network Authority does not list, even though the adapter points there", () => {
  return withFixtures(async (mods) => {
    approveAll(mods, { allowedHosts: ["other.example.test"] });
    await expectCode(
      mods.apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { value: "x" } }),
      "host_not_authorized",
    );
  });
});

test("execute rejects a request body that does not match the contract's request schema, before any network attempt", () => {
  return withFixtures(async (mods) => {
    approveAll(mods);
    await expectCode(
      mods.apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: { id: "1" }, requestBody: { wrong: "shape" } }),
      "request_contract_mismatch",
    );
  });
});

test("execute rejects a missing path parameter", () => {
  return withFixtures(async (mods) => {
    approveAll(mods);
    await expectCode(
      mods.apiClient.execute({ environmentId: "lawcus", semanticId: "sample.op", pathParams: {}, requestBody: { value: "x" } }),
      "missing_path_param",
    );
  });
});
