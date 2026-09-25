// A read-only sweep of a staging tenant for records this tool may have left
// behind. What it is, and is not:
//
//  - READ-ONLY. The browser reader may only load the tenant's own list pages;
//    permitSweepRequest below refuses every write (including the app's own
//    settings write), and nothing in this module can delete, edit or create a
//    record in staging.
//  - CANDIDATES, not proof. A record is a candidate when its NAME matches this
//    tool's own naming. A name is evidence to look at, never authority to touch
//    anything (resource-ownership.mjs says the same about deletion).
//  - PRIVATE. Only candidates are stored. The rest of the tenant's records,
//    which belong to other people, are counted but never copied.
//  - REVIEWED BY A PERSON. Each candidate is classified against the local
//    ownership records (tracked / protected / untracked) and a human marks
//    what it is.

import { randomUUID } from "node:crypto";
import { now } from "./store.mjs";
import { currentCodeRevision } from "./code-revision.mjs";
import { classifyThrown } from "./failure-class.mjs";
import { safeErrorMessage } from "./redact.mjs";
import { requireHumanApprover } from "./knowledge.mjs";
import { permitSweepRequest } from "./live-runner.mjs";
import { isQaNamed } from "./sweep-names.mjs";

export { isQaNamed };

export const SWEEP_KINDS = ["contact", "matter", "lead"];
export const REVIEW_STATUSES = ["confirmed_qa", "not_qa", "left_in_place"];

// The browser is restricted to the tenant's own list endpoints; see permitSweepRequest.
export { permitSweepRequest };

/** The earliest moment anything this tool did could have been created: a day
 * before its first recorded run (a margin for time zones). With no run on
 * record it looks back 30 days, plus the same one-day margin. */
export function defaultCutoff(db, nowMs = Date.now()) {
  const first = db.prepare("SELECT MIN(started_at) t FROM runs").get().t;
  const base = first ? Date.parse(first) : nowMs - 30 * 86400000;
  return new Date(base - 86400000).toISOString();
}

export function openStagingSweeps(db, audit, { protectedResourceIds = [] } = {}) {
  const protectedIds = new Set(protectedResourceIds);

  function classify(kind, remoteId, environmentId) {
    if (protectedIds.has(remoteId)) return { disposition: "protected", runId: null };
    const owned = db
      .prepare("SELECT run_id FROM resource_ownership WHERE environment_id=? AND resource_id=? AND resource_type=? ORDER BY created_at LIMIT 1")
      .get(environmentId, remoteId, kind);
    return owned ? { disposition: "tracked", runId: owned.run_id } : { disposition: "untracked", runId: null };
  }

  /** Starts a sweep row (status running). Refuses while another sweep is running. */
  function begin({ environmentId, cutoff = defaultCutoff(db), requestedBy }) {
    if (typeof requestedBy !== "string" || !requestedBy) throw new Error("A sweep must record who asked for it.");
    if (db.prepare("SELECT 1 FROM staging_sweeps WHERE status='running'").get()) {
      const error = new Error("A sweep is already running.");
      error.code = "sweep_running";
      throw error;
    }
    const id = randomUUID();
    db.prepare("INSERT INTO staging_sweeps(id,environment_id,status,cutoff,started_at,requested_by,code_revision) VALUES(?,?,'running',?,?,?,?)")
      .run(id, environmentId, cutoff, now(), requestedBy, currentCodeRevision());
    audit?.("staging_sweep.started", id, { environmentId, requestedBy });
    return id;
  }

  /**
   * Runs a sweep with `reader` (the browser part, injected so this logic can be
   * tested without staging). The reader returns, per kind:
   *   { records: [{ id, name, createdAt }], scanned, pagesRead, truncated, totalInTenant }
   */
  async function run({ sweepId, reader }) {
    const sweep = db.prepare("SELECT * FROM staging_sweeps WHERE id=?").get(sweepId);
    if (!sweep || sweep.status !== "running") throw new Error("That sweep is not running.");
    try {
      const result = await reader({ cutoff: sweep.cutoff });
      const scanned = {};
      let matched = 0;
      let untracked = 0;
      let truncated = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const kind of SWEEP_KINDS) {
          const part = result?.[kind];
          if (!part) continue;
          scanned[kind] = { scanned: part.scanned ?? part.records?.length ?? 0, pagesRead: part.pagesRead ?? null, truncated: Boolean(part.truncated), totalInTenant: part.totalInTenant ?? null };
          if (part.truncated) truncated = true;
          const seen = new Set();
          for (const record of part.records || []) {
            // Only this tool's own naming is ever stored, whatever the reader returned.
            if (!record?.id || seen.has(record.id) || !isQaNamed(record.name)) continue;
            seen.add(record.id);
            const { disposition, runId } = classify(kind, String(record.id), sweep.environment_id);
            db.prepare("INSERT INTO staging_sweep_records(id,sweep_id,kind,remote_id,name,created_at_remote,disposition,ownership_run_id) VALUES(?,?,?,?,?,?,?,?)")
              .run(randomUUID(), sweepId, kind, String(record.id), String(record.name).slice(0, 200), record.createdAt ?? null, disposition, runId);
            matched += 1;
            if (disposition === "untracked") untracked += 1;
          }
        }
        const status = truncated ? "partial" : "completed";
        const summary = truncated
          ? `Found ${matched} candidate record(s), ${untracked} not known to this tool. The look did not reach the cutoff date in every list, so older candidates may be missing.`
          : `Found ${matched} candidate record(s), ${untracked} not known to this tool. Every list was read back to the cutoff date.`;
        db.prepare("UPDATE staging_sweeps SET status=?,finished_at=?,scanned=?,matched_count=?,untracked_count=?,summary=? WHERE id=?")
          .run(status, now(), JSON.stringify(scanned), matched, untracked, summary, sweepId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      audit?.("staging_sweep.finished", sweepId, { matched, untracked, truncated });
    } catch (error) {
      const c = classifyThrown(error);
      db.prepare("UPDATE staging_sweeps SET status='failed',finished_at=?,summary=?,failure_class=?,reason_code=? WHERE id=?")
        .run(now(), `The sweep did not finish: ${safeErrorMessage(error, 300)}. ${c.explanation} Nothing was found or changed.`, c.failureClass, c.reasonCode, sweepId);
      audit?.("staging_sweep.failed", sweepId, { reasonCode: c.reasonCode });
    }
    return get(sweepId);
  }

  const present = (row) => (row ? { ...row, scanned: row.scanned ? JSON.parse(row.scanned) : null } : null);

  function list() {
    return db.prepare("SELECT * FROM staging_sweeps ORDER BY started_at DESC").all().map(present);
  }

  function get(id) {
    const sweep = db.prepare("SELECT * FROM staging_sweeps WHERE id=?").get(id);
    if (!sweep) return null;
    const records = db
      .prepare("SELECT * FROM staging_sweep_records WHERE sweep_id=? ORDER BY CASE disposition WHEN 'untracked' THEN 0 WHEN 'tracked' THEN 1 ELSE 2 END, created_at_remote DESC, name")
      .all(id);
    return { ...present(sweep), records };
  }

  /** A person records what a candidate turned out to be. Changes nothing in staging. */
  function review(recordId, { status, note = null, actor }) {
    requireHumanApprover(actor);
    if (!REVIEW_STATUSES.includes(status)) throw new Error(`Review status must be one of: ${REVIEW_STATUSES.join(", ")}.`);
    const changed = db
      .prepare("UPDATE staging_sweep_records SET review_status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?")
      .run(status, note ? String(note).slice(0, 1000) : null, actor, now(), recordId).changes;
    if (!changed) {
      const error = new Error("That sweep record could not be found.");
      error.code = "not_found";
      throw error;
    }
    audit?.("staging_sweep.record_reviewed", recordId, { status, actor });
    return db.prepare("SELECT * FROM staging_sweep_records WHERE id=?").get(recordId);
  }

  return { begin, run, list, get, review, classify };
}
