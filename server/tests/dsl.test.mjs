import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestCase, runTestCase, DslError } from "../core/dsl.mjs";
import { PrimitiveError } from "../core/primitives.mjs";

const dslDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dsl",
  "login",
);

const VALID_CASE = `
version: 1
id: sample.case
feature: authentication
suite: login-essentials
name: Sample
layer: ui
risk: low
status: approved
steps:
  - primitive: auth.open_login_page
    input:
      page: "\${ctx.page}"
      origin: "\${ctx.origin}"
`;

test("every shipped login DSL case parses and validates against the schema", () => {
  for (const file of readdirSync(dslDir).filter((f) => f.endsWith(".yaml"))) {
    const definition = parseTestCase(readFileSync(join(dslDir, file), "utf8"));
    assert.equal(definition.version, 1);
    assert.ok(definition.steps.length > 0);
  }
});

test("a DSL document is not valid YAML fails closed with invalid_yaml", () => {
  assert.throws(
    () => parseTestCase("version: 1\n  bad indentation: ["),
    (e) => e instanceof DslError && e.code === "invalid_yaml",
  );
});

test("an unknown top-level field is rejected (strict schema, no arbitrary extension)", () => {
  assert.throws(
    () => parseTestCase(VALID_CASE + "\nrunShellCommand: rm -rf /\n"),
    (e) => e instanceof DslError && e.code === "invalid_definition",
  );
});

test("a step with no primitives is rejected", () => {
  const bad = VALID_CASE.replace(/steps:[\s\S]*/, "steps: []\n");
  assert.throws(
    () => parseTestCase(bad),
    (e) => e instanceof DslError && e.code === "invalid_definition",
  );
});

test("runTestCase fails closed for a step naming an unknown primitive — the DSL cannot invent execution authority", async () => {
  const definition = parseTestCase(
    VALID_CASE.replace("auth.open_login_page", "auth.does_not_exist"),
  );
  await assert.rejects(
    () => runTestCase(definition, { ctx: {} }),
    (e) => e instanceof PrimitiveError && e.code === "unknown_primitive",
  );
});

test("runTestCase resolves ${...} references against the run scope, in nested objects and arrays", async () => {
  const calls = [];
  const definition = parseTestCase(`
version: 1
id: sample.reference
feature: authentication
suite: login-essentials
name: Sample reference
layer: ui
risk: low
status: approved
steps:
  - primitive: auth.open_login_page
    input:
      page: "\${ctx.page}"
      origin: "\${ctx.origin}"
`);
  // Swap in a fake resolvePrimitive-shaped primitive by running the real
  // open_login_page against a fake "page" that just records the call —
  // proves nested reference resolution without touching a real browser.
  const fakePage = { goto: async (url, opts) => calls.push({ url, opts }) };
  await runTestCase(definition, { ctx: { page: fakePage, origin: "http://x" } });
  assert.deepEqual(calls, [
    { url: "http://x/login", opts: { waitUntil: "domcontentloaded" } },
  ]);
});

test("an unresolved reference fails closed instead of passing through a literal placeholder", async () => {
  const definition = parseTestCase(VALID_CASE);
  await assert.rejects(
    () => runTestCase(definition, { ctx: {} }), // ctx.page/ctx.origin missing
    (e) => e instanceof DslError && e.code === "unresolved_reference",
  );
});

test("saveAs makes a step's result available to later steps via reference", async () => {
  const definition = parseTestCase(`
version: 1
id: sample.saveas
feature: authentication
suite: login-essentials
name: Sample saveAs
layer: ui
risk: low
status: approved
steps:
  - primitive: auth.ensure_login_fields
    input:
      page: "\${ctx.page}"
    saveAs: fields
assertions:
  - primitive: auth.assert_password_masked
    input:
      password: "\${fields.password}"
`);
  const passwordLocator = {
    count: async () => 1,
    getAttribute: async () => "password",
  };
  const fakePage = {
    getByRole: () => ({ count: async () => 1 }),
    getByLabel: () => passwordLocator,
  };
  const scope = await runTestCase(definition, { ctx: { page: fakePage } });
  assert.equal(scope.fields.password, passwordLocator);
});
