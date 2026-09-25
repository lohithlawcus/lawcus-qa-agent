import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePrimitive } from "./primitives.mjs";

// V5 section 11 — Safe Test DSL. A test case is strictly validated data: a
// primitive id plus a plain-value input for every step. Nothing here can
// carry executable code, a shell command, a file path, or an unbounded URL
// — the DSL cannot do anything beyond what a step's named, already-approved
// primitive (server/core/primitives.mjs) does. Every primitive reference is
// resolved through resolvePrimitive(), so an unknown, unapproved, or
// hash-mismatched primitive id fails the whole test case closed.

export const DSL_VERSION = 1;

export class DslError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const StepInput = z.record(z.string(), z.unknown()).default({});

const Step = z
  .object({
    primitive: z.string().min(1),
    input: StepInput,
    saveAs: z.string().min(1).optional(),
  })
  .strict();

export const TestCaseDefinition = z
  .object({
    version: z.literal(DSL_VERSION),
    id: z.string().min(1),
    feature: z.string().min(1),
    suite: z.string().min(1),
    name: z.string().min(1),
    layer: z.enum(["ui", "api", "both"]),
    risk: z.enum(["low", "normal", "high"]),
    status: z.enum(["approved", "pending_review", "deprecated"]),
    setup: z.array(Step).default([]),
    steps: z.array(Step).min(1),
    assertions: z.array(Step).default([]),
    cleanup: z.array(Step).default([]),
  })
  .strict();

export function parseTestCase(yamlText) {
  let raw;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new DslError(
      "invalid_yaml",
      `Test case is not valid YAML: ${e.message}`,
    );
  }
  const result = TestCaseDefinition.safeParse(raw);
  if (!result.success)
    throw new DslError(
      "invalid_definition",
      `Test case failed DSL validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  return result.data;
}

// Loads every *.yaml file in a directory as a DSL test case, keyed by
// filename (without extension). Keeps both the raw source (needed to
// version a case in the TestBook, Step 5) and its parsed, validated
// definition. Fails closed the same way parseTestCase() does — a malformed
// file here fails the caller's startup rather than being skipped.
export function loadTestCaseDirectory(dirPath) {
  const entries = {};
  for (const file of readdirSync(dirPath).filter((f) => f.endsWith(".yaml"))) {
    const key = file.replace(/\.yaml$/, "");
    const source = readFileSync(join(dirPath, file), "utf8");
    entries[key] = { source, definition: parseTestCase(source) };
  }
  return entries;
}

const REFERENCE = /^\$\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\}$/;

function resolveValue(value, scope) {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, scope));
  if (value && typeof value === "object") return resolveInput(value, scope);
  if (typeof value !== "string") return value;
  const match = REFERENCE.exec(value);
  if (!match) return value;
  const path = match[1].split(".");
  let current = scope;
  for (const key of path) {
    if (current == null || !(key in current))
      throw new DslError(
        "unresolved_reference",
        `DSL reference "${value}" does not resolve against the current run scope.`,
      );
    current = current[key];
  }
  return current;
}

function resolveInput(input, scope) {
  const resolved = {};
  for (const [key, value] of Object.entries(input))
    resolved[key] = resolveValue(value, scope);
  return resolved;
}

// Runs setup, then steps, then assertions, then cleanup, in that order,
// sharing one scope so later steps can reference earlier saveAs results.
// Every primitive call goes through resolvePrimitive() — the same
// fail-closed gate the runner used directly before this DSL layer existed.
export async function runTestCase(definition, initialScope) {
  const scope = { ...initialScope };
  for (const phase of ["setup", "steps", "assertions", "cleanup"]) {
    for (const step of definition[phase]) {
      try {
        const primitive = resolvePrimitive(step.primitive);
        const input = resolveInput(step.input, scope);
        const result = await primitive.run(input);
        if (step.saveAs) scope[step.saveAs] = result;
      } catch (error) {
        // Remember WHERE it failed: an assertion step that does not see the
        // expected state is a different thing from a setup step that could not
        // drive the page. Kept off the error's own properties (a logger could
        // serialize those); the primitives themselves are hash-pinned and are
        // deliberately not changed to carry this.
        if (error && typeof error === "object") failedSteps.set(error, { phase, primitive: step.primitive });
        throw error;
      }
    }
  }
  return scope;
}

const failedSteps = new WeakMap();

/** { phase, primitive } of the step that threw this error inside runTestCase, or null. */
export function takeFailedStep(error) {
  return error && typeof error === "object" ? (failedSteps.get(error) ?? null) : null;
}
