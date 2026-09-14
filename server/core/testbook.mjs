import { createHash, randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 5 / section 10 — the TestBook: Feature -> Suite -> Test Case ->
// Versioned Test Definition -> Execution History. Test cases and their
// definition versions are synced from already-validated DSL entries
// (server/core/dsl.mjs); execution history is read from the existing
// scenario_results/runs tables (section 5.4: migrate references, never
// delete or rewrite history).

function sourceHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function openTestBook(db, audit) {
  function caseStats(testCaseId) {
    const totals = db
      .prepare(
        `SELECT count(*) executions,
                sum(CASE WHEN status='passed' THEN 1 ELSE 0 END) passed,
                sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
         FROM scenario_results WHERE test_case_id=?`,
      )
      .get(testCaseId);
    const last = db
      .prepare(
        `SELECT scenario_results.status AS status, runs.started_at AS started_at
         FROM scenario_results JOIN runs ON runs.id = scenario_results.run_id
         WHERE scenario_results.test_case_id=?
         ORDER BY runs.started_at DESC LIMIT 1`,
      )
      .get(testCaseId);
    const lastPass = db
      .prepare(
        `SELECT runs.started_at AS started_at
         FROM scenario_results JOIN runs ON runs.id = scenario_results.run_id
         WHERE scenario_results.test_case_id=? AND scenario_results.status='passed'
         ORDER BY runs.started_at DESC LIMIT 1`,
      )
      .get(testCaseId);
    const lastFailure = db
      .prepare(
        `SELECT runs.started_at AS started_at
         FROM scenario_results JOIN runs ON runs.id = scenario_results.run_id
         WHERE scenario_results.test_case_id=? AND scenario_results.status='failed'
         ORDER BY runs.started_at DESC LIMIT 1`,
      )
      .get(testCaseId);
    return {
      executions: totals.executions || 0,
      passed: totals.passed || 0,
      failed: totals.failed || 0,
      lastExecutionAt: last?.started_at ?? null,
      lastStatus: last?.status ?? null,
      lastPassAt: lastPass?.started_at ?? null,
      lastFailureAt: lastFailure?.started_at ?? null,
    };
  }

  return {
    /**
     * Idempotently syncs a directory's worth of already-validated DSL test
     * case entries ({source, definition}, from loadTestCaseDirectory) into
     * the TestBook. Creates the feature/suite the first time they're seen,
     * creates each case the first time its external_id is seen, and
     * appends a NEW test_definition_versions row only when the DSL source
     * text actually changed since the last synced version — rows already
     * written are never updated (section 10: "Never rewrite historical
     * TestBook versions").
     */
    syncCases({
      featureName,
      featureDescription,
      suiteName,
      suiteDescription,
      priority = "normal",
      entries,
    }) {
      const at = now();
      let feature = db
        .prepare("SELECT * FROM features WHERE name=?")
        .get(featureName);
      if (!feature) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO features(id,name,description,created_at) VALUES(?,?,?,?)",
        ).run(id, featureName, featureDescription, at);
        feature = { id, name: featureName };
        audit?.("testbook.feature.created", id, { name: featureName });
      }
      let suite = db
        .prepare("SELECT * FROM test_suites WHERE feature_id=? AND name=?")
        .get(feature.id, suiteName);
      if (!suite) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO test_suites(id,feature_id,name,description,created_at) VALUES(?,?,?,?,?)",
        ).run(id, feature.id, suiteName, suiteDescription, at);
        suite = { id, feature_id: feature.id, name: suiteName };
        audit?.("testbook.suite.created", id, {
          feature: featureName,
          name: suiteName,
        });
      }
      const synced = [];
      for (const [key, { source, definition }] of Object.entries(entries)) {
        let testCase = db
          .prepare("SELECT * FROM test_cases WHERE external_id=?")
          .get(definition.id);
        if (!testCase) {
          const id = randomUUID();
          db.prepare(
            `INSERT INTO test_cases(id,suite_id,external_id,title,description,layer,priority,risk,status,tags,current_version,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            suite.id,
            definition.id,
            definition.name,
            definition.name,
            definition.layer,
            priority,
            definition.risk,
            definition.status,
            "[]",
            0,
            at,
          );
          testCase = { id, external_id: definition.id, current_version: 0 };
          audit?.("testbook.case.created", id, {
            externalId: definition.id,
            title: definition.name,
          });
        }
        const hash = sourceHash(source);
        const latestVersion = db
          .prepare(
            "SELECT * FROM test_definition_versions WHERE test_case_id=? ORDER BY version DESC LIMIT 1",
          )
          .get(testCase.id);
        let versionId = latestVersion?.id ?? null;
        if (!latestVersion || latestVersion.dsl_source_hash !== hash) {
          const nextVersion = (latestVersion?.version || 0) + 1;
          versionId = randomUUID();
          db.prepare(
            `INSERT INTO test_definition_versions(id,test_case_id,version,dsl_id,dsl_source,dsl_source_hash,created_at)
             VALUES(?,?,?,?,?,?,?)`,
          ).run(versionId, testCase.id, nextVersion, definition.id, source, hash, at);
          // test_cases is a current-state pointer, not history — its
          // denormalized fields track the latest version. Only the rows in
          // test_definition_versions above are immutable history.
          db.prepare(
            `UPDATE test_cases
             SET current_version=?, title=?, description=?, layer=?, risk=?, status=?
             WHERE id=?`,
          ).run(
            nextVersion,
            definition.name,
            definition.name,
            definition.layer,
            definition.risk,
            definition.status,
            testCase.id,
          );
          audit?.("testbook.definition.versioned", versionId, {
            externalId: definition.id,
            version: nextVersion,
          });
        }
        synced.push({ key, externalId: definition.id, testCaseId: testCase.id, versionId });
      }
      return synced;
    },

    /** The exact test_case_id/test_definition_version_id a run right now
     * should record for a given DSL external_id — its current synced
     * version. Returns null if the case isn't in the TestBook yet. */
    resolveCurrentDefinition(externalId) {
      const testCase = db
        .prepare("SELECT id, current_version FROM test_cases WHERE external_id=?")
        .get(externalId);
      if (!testCase) return null;
      const version = db
        .prepare(
          "SELECT id FROM test_definition_versions WHERE test_case_id=? AND version=?",
        )
        .get(testCase.id, testCase.current_version);
      return { testCaseId: testCase.id, versionId: version?.id ?? null };
    },

    /** Links pre-existing scenario_results rows (written before the
     * TestBook existed) to a case by exact scenario-name match, without
     * touching any other column. Never assigns a version to a historical
     * row — which version ran is genuinely unknown for those. */
    backfillHistory(scenarioToExternalId) {
      let updated = 0;
      for (const [scenario, externalId] of Object.entries(scenarioToExternalId)) {
        const testCase = db
          .prepare("SELECT id FROM test_cases WHERE external_id=?")
          .get(externalId);
        if (!testCase) continue;
        const result = db
          .prepare(
            "UPDATE scenario_results SET test_case_id=? WHERE scenario=? AND test_case_id IS NULL",
          )
          .run(testCase.id, scenario);
        updated += result.changes;
      }
      if (updated) audit?.("testbook.history.backfilled", "system", { updated });
      return updated;
    },

    /** Feature -> suites -> cases (with tags parsed and execution stats
     * attached), for the read-only TestBook view. */
    tree() {
      const features = db
        .prepare("SELECT * FROM features ORDER BY created_at")
        .all();
      return features.map((feature) => ({
        id: feature.id,
        name: feature.name,
        description: feature.description,
        suites: db
          .prepare("SELECT * FROM test_suites WHERE feature_id=? ORDER BY created_at")
          .all(feature.id)
          .map((suite) => ({
            id: suite.id,
            name: suite.name,
            description: suite.description,
            cases: db
              .prepare("SELECT * FROM test_cases WHERE suite_id=? ORDER BY created_at")
              .all(suite.id)
              .map((testCase) => ({
                id: testCase.id,
                externalId: testCase.external_id,
                title: testCase.title,
                description: testCase.description,
                layer: testCase.layer,
                priority: testCase.priority,
                risk: testCase.risk,
                status: testCase.status,
                tags: JSON.parse(testCase.tags),
                currentVersion: testCase.current_version,
                stats: caseStats(testCase.id),
              })),
          })),
      }));
    },
  };
}
