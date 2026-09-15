import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/store.mjs";
import { openNetworkAuthority, NetworkAuthorityError } from "../core/network-authority.mjs";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qa-network-authority-"));
  try {
    const { db, audit } = openStore(dir);
    return fn(openNetworkAuthority(db, audit), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveApprovedAuthority fails closed until a human approves", () => {
  withStore((authorities) => {
    assert.throws(
      () => authorities.resolveApprovedAuthority("lawcus"),
      (e) => e instanceof NetworkAuthorityError && e.code === "no_approved_authority",
    );
    const proposed = authorities.proposeAuthority({
      environmentId: "lawcus",
      allowedHosts: ["api.fiveriverz.com"],
      allowedMethods: ["GET", "POST"],
    });
    assert.equal(proposed.status, "pending_review");
    authorities.approveAuthority(proposed.id, "operator:test");
    const resolved = authorities.resolveApprovedAuthority("lawcus");
    assert.deepEqual(resolved.allowedHosts, ["api.fiveriverz.com"]);
    assert.deepEqual(resolved.allowedMethods, ["GET", "POST"]);
    assert.equal(resolved.allowRedirects, false);
  });
});

test("proposing the exact same policy again is a no-op regardless of array order", () => {
  withStore((authorities) => {
    authorities.proposeAuthority({ environmentId: "lawcus", allowedHosts: ["b.test", "a.test"], allowedMethods: ["POST", "GET"] });
    authorities.proposeAuthority({ environmentId: "lawcus", allowedHosts: ["a.test", "b.test"], allowedMethods: ["GET", "POST"] });
    assert.equal(authorities.inbox().length, 1);
  });
});

test("a changed policy appends a new version and supersedes the old approved one", () => {
  withStore((authorities) => {
    const v1 = authorities.proposeAuthority({ environmentId: "lawcus", allowedHosts: ["api.fiveriverz.com"], allowedMethods: ["GET"] });
    authorities.approveAuthority(v1.id, "operator:test");
    const v2 = authorities.proposeAuthority({ environmentId: "lawcus", allowedHosts: ["api.fiveriverz.com"], allowedMethods: ["GET", "POST"] });
    authorities.approveAuthority(v2.id, "operator:test");
    assert.equal(authorities.resolveApprovedAuthority("lawcus").version, 2);
    assert.equal(authorities.approved().length, 1);
  });
});

test("only a human approver may approve or reject", () => {
  withStore((authorities) => {
    const v1 = authorities.proposeAuthority({ environmentId: "lawcus", allowedHosts: ["api.fiveriverz.com"], allowedMethods: ["GET"] });
    assert.throws(
      () => authorities.approveAuthority(v1.id, "ai_planner"),
      (e) => e instanceof NetworkAuthorityError && e.code === "non_human_approver",
    );
  });
});
