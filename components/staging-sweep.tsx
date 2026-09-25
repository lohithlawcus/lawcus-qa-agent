"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { request } from "@/lib/qa-api";

type SweepRow = {
  id: string;
  status: "running" | "completed" | "partial" | "failed";
  cutoff: string;
  started_at: string;
  finished_at: string | null;
  scanned: Record<string, { scanned: number; pagesRead: number | null; truncated: boolean; totalInTenant: number | null }> | null;
  matched_count: number;
  untracked_count: number;
  summary: string | null;
  failure_class: string | null;
  reason_code: string | null;
  requested_by: string;
};

type Finding = {
  id: string;
  kind: "contact" | "matter" | "lead";
  remote_id: string;
  name: string;
  created_at_remote: string | null;
  disposition: "untracked" | "tracked" | "protected";
  ownership_run_id: string | null;
  review_status: "unreviewed" | "confirmed_qa" | "not_qa" | "left_in_place";
  review_note: string | null;
  reviewed_by: string | null;
};

type SweepDetail = SweepRow & { records: Finding[] };

const KIND_LABEL = { contact: "Contact", matter: "Matter", lead: "Lead" } as const;
const STATUS_LABEL = { running: "Running", completed: "Completed", partial: "Partial", failed: "Did not finish" } as const;
const REVIEW_LABEL = { unreviewed: "Not reviewed", confirmed_qa: "Ours", not_qa: "Not ours", left_in_place: "Left in place" } as const;
const DISPOSITION_LABEL = { untracked: "Not known to this tool", tracked: "Recorded by a run", protected: "Protected fixture" } as const;

const stamp = (value: string | null) =>
  value ? new Date(value.includes("T") || value.includes("Z") ? value : value.replace(" ", "T") + "Z").toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function StagingSweep() {
  const [sweeps, setSweeps] = useState<SweepRow[]>([]);
  const [detail, setDetail] = useState<SweepDetail | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fetchLatest = useCallback(async () => {
    const list = await request<{ sweeps: SweepRow[] }>("/sweeps");
    const latest = list.sweeps[0];
    const full = latest ? await request<{ sweep: SweepDetail }>("/sweeps/" + latest.id) : null;
    return { list: list.sweeps, detail: full?.sweep ?? null };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchLatest();
      setSweeps(result.list);
      setDetail(result.detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sweeps could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [fetchLatest]);

  // First load: results are applied after the request settles, never synchronously.
  useEffect(() => {
    let live = true;
    fetchLatest()
      .then((result) => {
        if (!live) return;
        setSweeps(result.list);
        setDetail(result.detail);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "The sweeps could not be loaded."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fetchLatest]);

  // While a sweep is running, look again every few seconds.
  const running = detail?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      await request("/sweeps", {});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sweep could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function review(id: string, status: "confirmed_qa" | "not_qa" | "left_in_place") {
    setBusy(true);
    setError("");
    try {
      const note = (notes[id] || "").trim();
      await request(`/sweeps/records/${id}/review`, { status, ...(note ? { note } : {}) });
      setNotes((n) => {
        const next = { ...n };
        delete next[id];
        return next;
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const findings = detail?.records ?? [];
  const groups: { key: Finding["disposition"]; items: Finding[] }[] = (["untracked", "tracked", "protected"] as const)
    .map((key) => ({ key, items: findings.filter((f) => f.disposition === key) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="panel">
      <div className="panel-heading">
        <div>
          <span className="section-label">READ-ONLY</span>
          <h2>Staging sweep</h2>
        </div>
        <Button disabled={busy || running || loading} onClick={() => void start()}>
          {busy || running ? <LoaderCircle className="spin" /> : <ScanSearch />}
          {running ? "Sweeping…" : "Sweep now"}
        </Button>
      </div>
      <p className="subtle">
        Looks through the staging tenant&apos;s own Contacts, Matters and Leads lists for records this tool may have left behind, using only
        this tool&apos;s naming. It reads and changes nothing in staging, keeps only records with this tool&apos;s naming (nobody else&apos;s),
        and signs in once. A matching name is a candidate, not proof: you decide what each one is.
      </p>
      {error && (
        <div className="notice error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {loading ? (
        <p className="subtle">Loading…</p>
      ) : !detail ? (
        <p className="subtle">No sweep has been run yet.</p>
      ) : (
        <>
          <div className="inline">
            <Badge variant="outline">{STATUS_LABEL[detail.status]}</Badge>
            <span className="small-note">
              Started {stamp(detail.started_at)} by {detail.requested_by} · looked back to {stamp(detail.cutoff)}
            </span>
          </div>
          {detail.summary && (
            <div className={"notice" + (detail.status === "failed" ? " error" : "")} role="status">
              {detail.status !== "completed" && <AlertTriangle size={16} />}
              <p>{detail.summary}</p>
            </div>
          )}
          {detail.scanned && (
            <p className="small-note">
              {(["contact", "matter", "lead"] as const)
                .filter((kind) => detail.scanned?.[kind])
                .map((kind) => {
                  const part = detail.scanned![kind];
                  return `${KIND_LABEL[kind]}s: read ${part.scanned}${part.totalInTenant ? ` of ${part.totalInTenant}` : ""}${part.truncated ? " (stopped before the cutoff)" : ""}`;
                })
                .join(" · ")}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key} style={{ marginTop: 16 }}>
              <span className="section-label">
                {DISPOSITION_LABEL[group.key].toUpperCase()} ({group.items.length})
              </span>
              <div className="scenario-list">
                {group.items.map((finding) => (
                  <div className="list-row" key={finding.id} style={{ display: "block" }}>
                    <div className="inline" style={{ justifyContent: "space-between" }}>
                      <h3>{finding.name}</h3>
                      <Badge variant="outline">{REVIEW_LABEL[finding.review_status]}</Badge>
                    </div>
                    <p className="subtle">
                      {KIND_LABEL[finding.kind]} · created {stamp(finding.created_at_remote)} · {finding.remote_id}
                    </p>
                    {finding.review_note && <p className="small-note">“{finding.review_note}” — {finding.reviewed_by}</p>}
                    <div className="inline">
                      <Input
                        aria-label={`Note for ${finding.name}`}
                        placeholder="Note (optional)"
                        value={notes[finding.id] || ""}
                        maxLength={1000}
                        onChange={(e) => setNotes({ ...notes, [finding.id]: e.target.value })}
                      />
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void review(finding.id, "confirmed_qa")}>
                        Ours
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void review(finding.id, "not_qa")}>
                        Not ours
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void review(finding.id, "left_in_place")}>
                        Leave in place
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {detail.status !== "running" && detail.status !== "failed" && findings.length === 0 && (
            <p className="subtle">No records with this tool&apos;s naming were found.</p>
          )}
          <p className="small-note">
            Nothing here deletes or edits anything in staging. &ldquo;Ours&rdquo;, &ldquo;Not ours&rdquo; and &ldquo;Leave in place&rdquo; only record your
            decision here.
            {sweeps.length > 1 ? ` ${sweeps.length - 1} earlier sweep${sweeps.length === 2 ? "" : "s"} on record.` : ""}
          </p>
        </>
      )}
    </div>
  );
}
