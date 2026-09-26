import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_CLASSES } from "../core/failure-class.mjs";
import { summarizeCells } from "../core/run-outcome.mjs";
import { STAGING_RUN_LIMIT, STAGING_RUN_WINDOW_MS } from "../core/run-admission.mjs";
import { MCP_HOURLY_LIMIT } from "../mcp/tools.mjs";
import { NATIVE_SUITE_MEMBERS, NATIVE_QUARANTINE } from "../testbook/lawcus-native-cases.mjs";

// The operator-facing docs make claims about the code. This keeps them honest:
// when the code changes and a doc does not, a test here fails.
process.env.QA_FORBID_LIVE = "1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const DOCS = ["README.md", "docs/DELIVERY-STATUS.md", "docs/ARCHITECTURE.md", "docs/OPERATOR-GUIDE.md", "docs/COVERAGE-AND-SECURITY.md"];
const docs = Object.fromEntries(DOCS.map((p) => [p, read(p)]));
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `missing section "${heading}"`);
  const rest = text.slice(start + 1);
  const end = rest.slice(3).search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end + 3);
};
const ticks = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const sorted = (set) => [...set].sort();

// ---------- every doc says when it is about ----------

test("each main doc states the date and a real commit it describes", () => {
  for (const [path, text] of Object.entries(docs)) {
    const match = /[Aa]s of (\d{1,2} [A-Z][a-z]+ \d{4}), commit `([0-9a-f]{7,40})`/.exec(text);
    assert.ok(match, `${path} has no "As of <date>, commit \`sha\`" line`);
    let known = true;
    try {
      execFileSync("git", ["cat-file", "-e", `${match[2]}^{commit}`], { cwd: root, stdio: "ignore" });
    } catch (error) {
      if (error.code === "ENOENT") known = false; // no git in this environment
      else assert.fail(`${path} names commit ${match[2]}, which is not in this repository`);
    }
    void known;
  }
});

test("known stale claims from the Login-only V1 are gone", () => {
  const stale = ["Local V1 login testing", "Seventeen tests", "suites, knowledge ingestion", "four fixed staging checks", "Local V1 architecture", "Delivery status — 11 September", "mutation requests to login/logout"];
  for (const [path, text] of Object.entries(docs)) for (const phrase of stale) assert.ok(!text.includes(phrase), `${path} still says "${phrase}"`);
});

// ---------- tools, migrations, routes ----------

test("the MCP tools the architecture lists are exactly the tools the server registers, and the count is right everywhere", () => {
  const server = read("server/mcp/server.mjs");
  const registered = [...server.matchAll(/register\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(registered.length >= 22);
  const documented = ticks(section(docs["docs/ARCHITECTURE.md"], "MCP tools")).filter((t) => /^[a-z]+(_[a-z]+)+$/.test(t));
  assert.deepEqual(sorted(new Set(documented)), sorted(new Set(registered)));
  for (const path of ["README.md", "docs/DELIVERY-STATUS.md"]) assert.match(docs[path], new RegExp(`\\b${registered.length} tools\\b`), `${path} states the tool count`);
  assert.match(docs["docs/ARCHITECTURE.md"], new RegExp(`capped at ${MCP_HOURLY_LIMIT} per hour`));
});

test("the migrations table lists every migration file, and only those", () => {
  const files = readdirSync(join(root, "server/migrations")).filter((f) => f.endsWith(".sql"));
  const documented = ticks(section(docs["docs/ARCHITECTURE.md"], "Database migrations")).filter((t) => t.endsWith(".sql"));
  assert.deepEqual(sorted(documented), sorted(files));
});

test("the route families the architecture lists are exactly the ones the control service serves", () => {
  const index = read("server/index.mjs");
  const families = new Set();
  for (const m of index.matchAll(/pathname\s*===\s*["']\/([a-z-]+)/g)) families.add(m[1]);
  for (const m of index.matchAll(/pathname\.startsWith\(["']\/([a-z-]+)/g)) families.add(m[1]);
  for (const m of index.matchAll(/\/\^\\\/([a-z-]+)/g)) families.add(m[1]);
  const rows = section(docs["docs/ARCHITECTURE.md"], "HTTP routes").split("\n").filter((l) => l.startsWith("| `/"));
  const documented = new Set(rows.map((l) => /`\/([a-z-]+)[^`]*`/.exec(l)[1]));
  assert.deepEqual(sorted(documented), sorted(families));
});

// ---------- what the operator sees ----------

test("every tab the operator guide names is a real tab, and every top-level tab is named", () => {
  const page = read("app/page.tsx").replaceAll("&amp;", "&");
  const rows = section(docs["docs/OPERATOR-GUIDE.md"], "The tabs").split("\n").filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith("| Tab "));
  const labels = rows.map((l) => l.split("|")[1].trim());
  assert.equal(labels.length, 12);
  for (const label of labels) assert.ok(page.includes(label), `no tab or heading "${label}" in the workspace`);
  const topLevel = [...read("app/page.tsx").matchAll(/<TabsTrigger value="(workspace|testbook|ai-usage|history|proposals|knowledge|review|api|personas|teach|safety|environment)"/g)];
  assert.equal(topLevel.length, labels.length);
  const guide = docs["docs/OPERATOR-GUIDE.md"];
  for (const wording of ["Sign in and save verified account", "Check browser connection", "Build plan", "Use standard login checks", "I removed it", "Keep it", "Records left in staging", "Sweep now", "Record and analyze", "Propose a revision", "Flag for re-review", "Load example", "Approve"]) {
    assert.ok(guide.includes(wording), `the guide should mention "${wording}"`);
  }
  const ui = read("app/page.tsx") + read("app/secure-setup.tsx") + read("components/staging-sweep.tsx") + read("components/change-signals.tsx");
  for (const wording of ["Sign in and save verified account", "Check browser connection", "Build plan", "Use standard login checks", "I removed it", "Keep it", "Sweep now", "Record and analyze", "Propose a revision", "Flag for re-review", "Load example"]) {
    assert.ok(ui.includes(wording), `the UI no longer says "${wording}", which the operator guide quotes`);
  }
  assert.ok(/RECORDS LEFT IN STAGING/.test(ui), "the leftovers heading the guide describes exists");
});

test("the failure kinds and outcomes the guide explains are exactly the ones the code produces", () => {
  const guide = docs["docs/OPERATOR-GUIDE.md"];
  const kinds = ticks(section(guide, "Reading a result").split("Each check that did not pass")[1]).filter((t) => /^[a-z]+$/.test(t));
  assert.deepEqual(sorted(new Set(kinds.filter((k) => FAILURE_CLASSES.includes(k)))), sorted(FAILURE_CLASSES));
  const produced = new Set(["cancelled"]);
  const cell = (status, failureClass) => ({ executed: true, status, ...(failureClass ? { failureClass } : {}) });
  for (const cells of [[], [cell("passed")], [cell("passed"), { executed: false }], [cell("failed", "functional")], [cell("failed", "infrastructure")], [cell("failed", "integrity")]]) produced.add(summarizeCells(cells).outcome);
  const outcomes = ticks(section(guide, "Reading a result").split("Each check that did not pass")[0]).filter((t) => /^[a-z]+$/.test(t));
  assert.deepEqual(sorted(new Set(outcomes)), sorted(produced));
});

// ---------- the evidence table, limits and commands ----------

test("the staging results table lists exactly the native cases, and marks exactly the quarantined ones", () => {
  const status = docs["docs/DELIVERY-STATUS.md"];
  const fiveriverz = status.slice(status.indexOf("### Fiveriverz"), status.indexOf("### Other tenants"));
  const rows = fiveriverz.split("\n").filter((l) => /^\| `[a-z_.]+` \|/.test(l));
  const ids = rows.map((l) => /^\| `([a-z_.]+)`/.exec(l)[1]);
  const native = ids.filter((id) => id.includes("."));
  assert.deepEqual(sorted(native), sorted(Object.values(NATIVE_SUITE_MEMBERS).flat()));
  assert.deepEqual(sorted(ids.filter((id) => !id.includes("."))), ["empty_fields", "logout", "password_masked", "valid_login"]);
  for (const row of rows) {
    const id = /^\| `([a-z_.]+)`/.exec(row)[1];
    assert.equal(/quarantined/.test(row), id in NATIVE_QUARANTINE, `${id}: the quarantine marker must match the code`);
  }
});

test("the limits the docs state match the code", () => {
  assert.equal(STAGING_RUN_LIMIT, 3);
  assert.equal(STAGING_RUN_WINDOW_MS, 600000);
  for (const path of ["docs/OPERATOR-GUIDE.md", "docs/ARCHITECTURE.md", "docs/DELIVERY-STATUS.md"]) {
    assert.match(docs[path], /three (?:staging )?sign-ins per ten minutes|Runs are capped at three per ten minutes/i, `${path} states the sign-in budget`);
  }
  const router = read("server/ai/router.mjs");
  assert.ok(router.includes("gpt-4.1-mini") && docs["docs/ARCHITECTURE.md"].includes("gpt-4.1-mini"));
  assert.ok(read("server/ai/providers/openai.mjs").includes("store: false") && /storage disabled/.test(docs["docs/ARCHITECTURE.md"]));
});

test("the README's commands exist, and every relative link in the docs points at a real file", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  for (const name of new Set([...docs["README.md"].matchAll(/npm (?:run )?([a-z:]+)/g)].map((m) => m[1]))) {
    if (name === "ci") continue; // npm ci is a built-in
    assert.ok(name === "test" || name in scripts, `README mentions "npm ${name}", which is not a script`);
  }
  for (const [path, text] of Object.entries(docs)) {
    for (const m of text.matchAll(/\]\((?!https?:|#)([^)#\s]+)/g)) {
      const target = resolve(root, dirname(path), m[1]);
      assert.ok(existsSync(target), `${path} links to ${m[1]}, which does not exist`);
    }
  }
  assert.ok(scripts["test:browser"], "the browser test script the README calls out exists");
  assert.match(docs["README.md"], /`npm test` does \*\*not\*\* run the browser tests/);
});
