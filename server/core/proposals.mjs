import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";

// V5 section 14. Every rule in that section is enforced here, in code, rather
// than by convention in a UI layer.

export const PROPOSAL_TYPES = new Set([
  "NEW_TEST",
  "TEST_CHANGE",
  "NEW_PRIMITIVE",
  "PRIMITIVE_CHANGE",
  "LOCATOR_REPAIR",
  "TESTABILITY_HOOK_REQUEST",
  "KNOWLEDGE_CHANGE",
  "DEPENDENCY_CHANGE",
  "API_CONTRACT_CHANGE",
  "ENVIRONMENT_CHANGE",
  "NETWORK_AUTHORITY_CHANGE",
  "PERMISSION_CHANGE",
]);

// section 14: "AI cannot approve", "browser content cannot approve",
// "API response cannot approve", "document text cannot approve".
// Only an interactive operator identity may ever appear as an approver.
const NON_HUMAN_ORIGINS = new Set([
  "runner",
  "ai_planner",
  "recorder",
  "network_observer",
  "impacted_testing",
  "mcp_tool",
]);

const DEFAULT_TTL_HOURS = 72;

export class ProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function openProposals(db, audit) {
  const readTrusted = (kind, id) =>
    db
      .prepare(
        "SELECT version,value FROM trusted_versions WHERE subject_kind=? AND subject_id=?",
      )
      .get(kind, id);

  return {
    readTrusted,

    /**
     * Record a proposal. This NEVER mutates trusted_versions — that is the
     * whole point of Step 1. A candidate locator becomes a proposal, and the
     * trusted path stays exactly as it was until a human approves.
     */
    create({
      type,
      summary,
      trigger,
      subjectKind,
      subjectId,
      proposedValue,
      evidence = [],
      confidence = null,
      risk = "medium",
      impactedFeatures = [],
      impactedTests = [],
      impactedApiContracts = [],
      requiredApproverRole = "engineering",
      generatedBy,
      runId = null,
      ttlHours = DEFAULT_TTL_HOURS,
    }) {
      if (!PROPOSAL_TYPES.has(type))
        throw new ProposalError("unknown_type", `Unknown proposal type: ${type}`);
      if (!summary || !trigger)
        throw new ProposalError(
          "incomplete",
          "A proposal requires a human-readable summary and a trigger.",
        );

      const trusted = readTrusted(subjectKind, subjectId);
      const baseVersion = trusted ? trusted.version : 0;
      const currentValue = trusted ? trusted.value : null;

      if (currentValue !== null && currentValue === String(proposedValue))
        throw new ProposalError(
          "no_change",
          "The proposed value already matches the trusted value.",
        );

      const id = randomUUID();
      const createdAt = now();
      const expiresAt = new Date(
        Date.parse(createdAt) + ttlHours * 3600_000,
      ).toISOString();

      db.prepare(
        `INSERT INTO proposals(
           id,type,status,summary,trigger,subject_kind,subject_id,base_version,
           current_value,proposed_value,evidence,confidence,risk,
           impacted_features,impacted_tests,impacted_api_contracts,
           required_approver_role,generated_by,run_id,created_at,expires_at)
         VALUES(?,?,'pending_review',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        type,
        summary,
        trigger,
        subjectKind,
        subjectId,
        baseVersion,
        currentValue,
        String(proposedValue),
        JSON.stringify(evidence),
        confidence,
        risk,
        JSON.stringify(impactedFeatures),
        JSON.stringify(impactedTests),
        JSON.stringify(impactedApiContracts),
        requiredApproverRole,
        generatedBy,
        runId,
        createdAt,
        expiresAt,
      );

      audit?.("proposal.created", id, {
        type,
        subjectKind,
        subjectId,
        baseVersion,
        generatedBy,
        runId,
      });
      return id;
    },

    get(id) {
      return db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
    },

    inbox(status = "pending_review") {
      return db
        .prepare(
          "SELECT * FROM proposals WHERE status=? ORDER BY created_at DESC",
        )
        .all(status);
    },

    /**
     * section 14: "approval transitions are transactional" and
     * "Before approving a proposal, confirm its base version still matches the
     * currently trusted version."
     */
    approve(id, approver, note = null) {
      if (!approver || typeof approver !== "string")
        throw new ProposalError("no_approver", "An approver identity is required.");
      if (NON_HUMAN_ORIGINS.has(approver))
        throw new ProposalError(
          "non_human_approver",
          "Runners, AI planners, recorders and observers can never approve a proposal.",
        );

      db.exec("BEGIN IMMEDIATE");
      try {
        const p = db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
        if (!p) throw new ProposalError("not_found", "No such proposal.");
        if (p.status !== "pending_review")
          throw new ProposalError(
            "not_pending",
            `Proposal is ${p.status}, not pending_review.`,
          );
        if (Date.parse(p.expires_at) <= Date.now()) {
          db.prepare(
            "UPDATE proposals SET status='expired',decided_at=? WHERE id=?",
          ).run(now(), id);
          db.exec("COMMIT");
          audit?.("proposal.expired", id, {});
          throw new ProposalError("expired", "This proposal has expired.");
        }
        // section 14: "proposal cannot approve itself" — the approver may not be
        // the non-human origin that generated it.
        if (p.generated_by === approver)
          throw new ProposalError(
            "self_approval",
            "A proposal cannot approve itself.",
          );

        // Optimistic concurrency: staleness check against the live trusted row.
        const trusted = readTrusted(p.subject_kind, p.subject_id);
        const liveVersion = trusted ? trusted.version : 0;
        if (liveVersion !== p.base_version) {
          db.prepare(
            "UPDATE proposals SET status='superseded',decided_at=?,decision_note=? WHERE id=?",
          ).run(
            now(),
            `Trusted version moved from ${p.base_version} to ${liveVersion} before approval.`,
            id,
          );
          db.exec("COMMIT");
          audit?.("proposal.superseded", id, {
            baseVersion: p.base_version,
            liveVersion,
          });
          throw new ProposalError(
            "stale",
            "The trusted version changed since this proposal was created. Review it again.",
          );
        }

        const nextVersion = liveVersion + 1;
        const at = now();
        db.prepare(
          `INSERT INTO trusted_versions(subject_kind,subject_id,version,value,updated_at,updated_by_proposal)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(subject_kind,subject_id) DO UPDATE SET
             version=excluded.version, value=excluded.value,
             updated_at=excluded.updated_at, updated_by_proposal=excluded.updated_by_proposal`,
        ).run(
          p.subject_kind,
          p.subject_id,
          nextVersion,
          p.proposed_value,
          at,
          id,
        );
        db.prepare(
          "UPDATE proposals SET status='approved',decided_at=?,decided_by=?,decision_note=? WHERE id=?",
        ).run(at, approver, note, id);

        // Any other pending proposal for the same subject is now stale.
        db.prepare(
          `UPDATE proposals SET status='superseded',decided_at=?,decision_note=?
             WHERE subject_kind=? AND subject_id=? AND status='pending_review' AND id<>?`,
        ).run(
          at,
          `Superseded by approved proposal ${id}.`,
          p.subject_kind,
          p.subject_id,
          id,
        );
        db.exec("COMMIT");
        audit?.("proposal.approved", id, {
          approver,
          subjectKind: p.subject_kind,
          subjectId: p.subject_id,
          version: nextVersion,
        });
        return { version: nextVersion, value: p.proposed_value };
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    },

    reject(id, approver, note = null) {
      if (!approver || NON_HUMAN_ORIGINS.has(approver))
        throw new ProposalError(
          "non_human_approver",
          "Only an operator may reject a proposal.",
        );
      const at = now();
      const r = db
        .prepare(
          "UPDATE proposals SET status='rejected',decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='pending_review'",
        )
        .run(at, approver, note, id);
      if (r.changes === 0)
        throw new ProposalError("not_pending", "Proposal is not pending review.");
      audit?.("proposal.rejected", id, { approver });
      return true;
    },

    expireStale() {
      const at = now();
      const r = db
        .prepare(
          "UPDATE proposals SET status='expired',decided_at=? WHERE status='pending_review' AND expires_at<=?",
        )
        .run(at, at);
      if (r.changes > 0) audit?.("proposal.expired.sweep", "system", { count: r.changes });
      return r.changes;
    },
  };
}
