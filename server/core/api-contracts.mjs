import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 Step 10 / section 19 — API Contract Registry. Same discipline as
// Knowledge (Step 9): a contract is proposed, never self-approved, and a
// changed contract is a new version that never rewrites the one it
// supersedes. provenance distinguishes official Lawcus API documentation
// ('DOCUMENTED') from behavior this project has itself observed against
// real staging ('OBSERVED_API') — see server/api-contracts/lawcus-seed.mjs
// for why every contract shipped with Step 10 is OBSERVED_API: no official
// Lawcus API documentation has been supplied yet (section 19: "Do not
// invent endpoint paths, methods, required headers, status codes, schemas.")

export class ApiContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NON_HUMAN_ORIGINS = new Set(["ai_extraction", "ai_planner", "runner", "network_observer"]);

function requireHumanApprover(approver) {
  if (!approver || typeof approver !== "string")
    throw new ApiContractError("no_approver", "An approver identity is required.");
  if (NON_HUMAN_ORIGINS.has(approver))
    throw new ApiContractError(
      "non_human_approver",
      "AI/observer capture can propose an API Contract; only a human operator can approve or reject it.",
    );
}

export function openApiContracts(db, audit) {
  function ensureFeature(name, description) {
    let feature = db.prepare("SELECT * FROM features WHERE name=?").get(name);
    if (!feature) {
      const id = randomUUID();
      db.prepare("INSERT INTO features(id,name,description,created_at) VALUES(?,?,?,?)").run(
        id,
        name,
        description,
        now(),
      );
      feature = { id, name, description };
      audit?.("api_contract.feature.created", id, { name });
    }
    return feature;
  }

  function ensureDocSource({ title, url, author }) {
    if (url) {
      const existing = db.prepare("SELECT * FROM knowledge_sources WHERE url=?").get(url);
      if (existing) return existing;
    }
    const id = randomUUID();
    db.prepare("INSERT INTO knowledge_sources(id,title,url,author,ingested_at) VALUES(?,?,?,?,?)").run(
      id,
      title,
      url ?? null,
      author ?? null,
      now(),
    );
    audit?.("api_contract.doc_source.ingested", id, { title, url });
    return { id, title, url, author };
  }

  /**
   * Proposes one versioned API contract (section 19). Idempotent on
   * semantic_id + a content fingerprint of everything that defines the
   * contract's behavior — re-proposing an unchanged contract is a no-op; a
   * genuine change appends a new version referencing the one it supersedes.
   */
  function proposeContract({
    semanticId,
    featureName,
    featureDescription,
    operation,
    method,
    pathTemplate,
    requestSchema = null,
    responseSchema,
    expectedStatuses,
    errorContract = null,
    readWrite,
    verificationRequirements,
    provenance,
    docSource = null,
    docVersion = null,
    docDate = null,
  }) {
    const feature = ensureFeature(featureName, featureDescription);
    const sourceRow = docSource ? ensureDocSource(docSource) : null;
    const requestSchemaJson = requestSchema ? JSON.stringify(requestSchema) : null;
    const responseSchemaJson = JSON.stringify(responseSchema);
    const expectedStatusesJson = JSON.stringify(expectedStatuses);
    const errorContractJson = errorContract ? JSON.stringify(errorContract) : null;
    const latest = db
      .prepare("SELECT * FROM api_contracts WHERE semantic_id=? ORDER BY version DESC LIMIT 1")
      .get(semanticId);
    if (
      latest &&
      latest.feature_id === feature.id &&
      latest.operation === operation &&
      latest.method === method &&
      latest.path_template === pathTemplate &&
      latest.request_schema === requestSchemaJson &&
      latest.response_schema === responseSchemaJson &&
      latest.expected_statuses === expectedStatusesJson &&
      latest.error_contract === errorContractJson &&
      latest.read_write === readWrite &&
      latest.verification_requirements === verificationRequirements &&
      latest.provenance === provenance &&
      latest.doc_source_id === (sourceRow?.id ?? null) &&
      latest.doc_version === docVersion &&
      latest.doc_date === docDate
    )
      return latest;
    const nextVersion = (latest?.version || 0) + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO api_contracts(
         id,semantic_id,version,feature_id,operation,method,path_template,
         request_schema,response_schema,expected_statuses,error_contract,
         read_write,verification_requirements,provenance,doc_source_id,
         doc_version,doc_date,status,supersedes,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      semanticId,
      nextVersion,
      feature.id,
      operation,
      method,
      pathTemplate,
      requestSchemaJson,
      responseSchemaJson,
      expectedStatusesJson,
      errorContractJson,
      readWrite,
      verificationRequirements,
      provenance,
      sourceRow?.id ?? null,
      docVersion,
      docDate,
      "pending_review",
      latest?.id ?? null,
      now(),
    );
    audit?.("api_contract.proposed", id, { semanticId, version: nextVersion, provenance });
    return db.prepare("SELECT * FROM api_contracts WHERE id=?").get(id);
  }

  function decideContract(id, status, approver, note) {
    requireHumanApprover(approver);
    const at = now();
    const result = db
      .prepare(
        "UPDATE api_contracts SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending_review'",
      )
      .run(status, approver, at, note ?? null, id);
    if (!result.changes)
      throw new ApiContractError("not_pending", "This API contract is not pending review.");
    if (status === "approved") {
      const row = db.prepare("SELECT * FROM api_contracts WHERE id=?").get(id);
      db.prepare(
        `UPDATE api_contracts SET status='superseded',decided_at=?,decision_note=?
         WHERE semantic_id=? AND status='approved' AND id<>?`,
      ).run(at, `Superseded by approved version ${row.version}.`, row.semantic_id, id);
    }
    audit?.(`api_contract.${status}`, id, { approver });
    return db.prepare("SELECT * FROM api_contracts WHERE id=?").get(id);
  }

  const approveContract = (id, approver, note) => decideContract(id, "approved", approver, note);
  const rejectContract = (id, approver, note) => decideContract(id, "rejected", approver, note);

  /** The one currently-trusted version for a semantic id. Fails closed:
   * the Safe API Executor (and the api.* DSL primitives) must never fall
   * back to a pending_review or rejected contract. */
  function resolveApprovedContract(semanticId) {
    const row = db
      .prepare("SELECT * FROM api_contracts WHERE semantic_id=? AND status='approved'")
      .get(semanticId);
    if (!row)
      throw new ApiContractError(
        "no_approved_contract",
        `No approved API contract exists for "${semanticId}".`,
      );
    return {
      ...row,
      requestSchema: row.request_schema ? JSON.parse(row.request_schema) : null,
      responseSchema: JSON.parse(row.response_schema),
      expectedStatuses: JSON.parse(row.expected_statuses),
      errorContract: row.error_contract ? JSON.parse(row.error_contract) : null,
    };
  }

  /**
   * Records a real Safe API Executor call as sanitized evidence (section
   * 22). When the response did not conform to the resolved contract, this
   * does NOT touch the trusted contract row — drift is visible via
   * contract_match=0 rows and, for a repeatable mismatch, should prompt a
   * new proposeContract() call with the corrected shape for human review
   * (section 19: "It must not automatically become an approved API
   * contract" — drift is surfaced, never silently healed).
   */
  function recordCall({
    contractId,
    environmentId,
    runId = null,
    requestSummary,
    responseStatus,
    responseSummary,
    contractMatch,
    mismatchReason = null,
    durationMs,
  }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO api_calls(
         id,contract_id,environment_id,run_id,request_summary,response_status,
         response_summary,contract_match,mismatch_reason,duration_ms,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      contractId,
      environmentId,
      runId,
      JSON.stringify(requestSummary),
      responseStatus ?? null,
      responseSummary ? JSON.stringify(responseSummary) : null,
      contractMatch ? 1 : 0,
      mismatchReason,
      durationMs,
      now(),
    );
    audit?.("api_call.recorded", id, { contractId, environmentId, contractMatch });
    return db.prepare("SELECT * FROM api_calls WHERE id=?").get(id);
  }

  function inbox() {
    return db
      .prepare(
        `SELECT api_contracts.*, features.name AS feature_name
         FROM api_contracts JOIN features ON features.id = api_contracts.feature_id
         WHERE api_contracts.status='pending_review' ORDER BY api_contracts.created_at`,
      )
      .all();
  }

  function approvedByFeature() {
    const rows = db
      .prepare(
        `SELECT api_contracts.*, features.name AS feature_name
         FROM api_contracts JOIN features ON features.id = api_contracts.feature_id
         WHERE api_contracts.status='approved' ORDER BY features.name, api_contracts.operation`,
      )
      .all();
    const byFeature = new Map();
    for (const row of rows) {
      if (!byFeature.has(row.feature_name)) byFeature.set(row.feature_name, []);
      byFeature.get(row.feature_name).push(row);
    }
    return [...byFeature.entries()].map(([feature, items]) => ({ feature, items }));
  }

  function recentCalls(contractId, limit = 20) {
    return db
      .prepare("SELECT * FROM api_calls WHERE contract_id=? ORDER BY created_at DESC LIMIT ?")
      .all(contractId, limit);
  }

  return {
    ensureFeature,
    proposeContract,
    approveContract,
    rejectContract,
    resolveApprovedContract,
    recordCall,
    inbox,
    approvedByFeature,
    recentCalls,
  };
}
