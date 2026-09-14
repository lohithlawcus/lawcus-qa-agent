import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrimitive, PrimitiveError } from "./primitives.mjs";
import { now } from "./store.mjs";

// V5 Step 6 / section 15 — Immutable Run Execution Manifest. Built once, at
// run creation, before execution begins, and stored write-once in
// run_execution_manifests. It only records fields this codebase actually
// has (see the migration's comment for what's deliberately excluded).

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let cachedRevision;
function runnerRevision() {
  if (cachedRevision !== undefined) return cachedRevision;
  try {
    cachedRevision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    cachedRevision = null;
  }
  return cachedRevision;
}

/**
 * Resolves and freezes the exact test-case/DSL/primitive versions a plan's
 * scenarios currently point to. Fails closed (ManifestError) if any
 * scenario's DSL case isn't yet in the TestBook, or references a primitive
 * that isn't a known, approved, hash-matching one — a run must not be able
 * to start on trust it doesn't actually have.
 */
export function buildRunManifest({
  testbook,
  testCases,
  scenarios,
  environmentId,
  requestedIntent,
  requester,
  triggerSource,
}) {
  const cases = scenarios.map((scenario) => {
    const definition = testCases[scenario];
    if (!definition)
      throw new ManifestError(
        "unknown_scenario",
        `No DSL test case is loaded for scenario "${scenario}".`,
      );
    const linked = testbook.resolveCurrentDefinition(definition.id);
    if (!linked)
      throw new ManifestError(
        "case_not_in_testbook",
        `"${definition.id}" has not been synced into the TestBook yet.`,
      );
    return {
      scenario,
      externalId: definition.id,
      testCaseId: linked.testCaseId,
      version: linked.version,
      versionId: linked.versionId,
    };
  });

  const primitiveIds = new Set();
  for (const scenario of scenarios) {
    const definition = testCases[scenario];
    for (const phase of ["setup", "steps", "assertions", "cleanup"])
      for (const step of definition[phase]) primitiveIds.add(step.primitive);
  }
  const primitives = [...primitiveIds].sort().map((id) => {
    try {
      const primitive = resolvePrimitive(id);
      return { id: primitive.id, version: primitive.version };
    } catch (e) {
      if (e instanceof PrimitiveError)
        throw new ManifestError(
          "primitive_not_trusted",
          `Cannot start this run: primitive "${id}" is ${e.code} (${e.message})`,
        );
      throw e;
    }
  });

  return {
    version: 1,
    environmentId,
    requestedIntent,
    requester,
    triggerSource,
    runnerRevision: runnerRevision(),
    testCases: cases,
    primitives,
    createdAt: now(),
  };
}
