// Checks that cost nothing on staging, run before a staging sign-in is spent.
// A run that could not have produced evidence, or could not reach the tenant,
// should be refused up front instead of using one of the three sign-ins the
// shared account is allowed per ten minutes (see run-admission.mjs).
//
// Every probe is injected, so the tests never touch the Keychain, the network
// or a browser. None of these checks sends anything to staging: the tenant
// check is a DNS lookup only.
import { existsSync, accessSync, constants, mkdirSync } from "node:fs";
import { lookup } from "node:dns/promises";

export const TENANT_HOSTS = ["lohith.fiveriverz.com", "api.fiveriverz.com"];

const defaults = {
  evidenceKeyExists: async () => {
    const { keychain } = await import("./secrets.mjs");
    return Boolean((await keychain("exists", "artifact-key")).exists);
  },
  chromiumPath: async () => {
    const { chromium } = await import("playwright");
    return chromium.executablePath();
  },
  resolveHost: async (host) => (await lookup(host)).address,
};

async function attempt(id, label, work) {
  try {
    const detail = await work();
    return { id, label, ok: detail !== false, detail: typeof detail === "string" ? detail : "" };
  } catch (error) {
    return { id, label, ok: false, detail: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * @returns {{ok:boolean, checks:{id:string,label:string,ok:boolean,detail:string}[], failed:string[]}}
 */
export async function runPreflight({ artifactDirectory, hosts = TENANT_HOSTS, probes = {} } = {}) {
  const p = { ...defaults, ...probes };
  const checks = [
    await attempt("evidence_key", "Evidence key is in the Keychain", async () =>
      (await p.evidenceKeyExists()) ? "present" : "missing: without it a run's evidence cannot be saved"),
    await attempt("evidence_directory", "Evidence folder is writable", async () => {
      mkdirSync(artifactDirectory, { recursive: true });
      accessSync(artifactDirectory, constants.W_OK);
      return "writable";
    }),
    await attempt("browser_installed", "Chromium is installed", async () => {
      const path = await p.chromiumPath();
      return path && existsSync(path) ? "installed" : "missing: run npx playwright install chromium";
    }),
    ...(await Promise.all(
      hosts.map((host) => attempt(`dns:${host}`, `Tenant host ${host} resolves`, async () => ((await p.resolveHost(host)) ? "resolves" : false))),
    )),
  ];
  // "missing: ..." details are failures even though the probe itself returned.
  for (const c of checks) if (c.ok && c.detail.startsWith("missing")) c.ok = false;
  const failed = checks.filter((c) => !c.ok);
  return { ok: failed.length === 0, checks, failed: failed.map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`) };
}

/** One sentence for an error response or an MCP error. */
export function preflightMessage(result) {
  return `Not started, and no staging sign-in was used. Fix first: ${result.failed.join("; ")}.`;
}
