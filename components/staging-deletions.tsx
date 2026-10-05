"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/qa-api";

type OwnedRecord = {
  id: string;
  resource_type: string;
  resource_id: string;
  display_name: string | null;
  cleanup_policy: string;
  cleanup_status: string;
  created_at: string;
};
type DeletionList = { approved: OwnedRecord[]; candidates: OwnedRecord[] };

const stamp = (value: string) => new Date(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z")).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

// Approving a deletion only marks one record the tool created. Nothing is deleted
// from Lawcus until a deletion run is started, and that run is not available in
// this app yet.
export function StagingDeletions() {
  const [list, setList] = useState<DeletionList>({ approved: [], candidates: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      setList(await request<DeletionList>("/deletions"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The deletion list could not be loaded.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    request<DeletionList>("/deletions")
      .then((l) => live && setList(l))
      .catch((e) => live && setError(e instanceof Error ? e.message : "The deletion list could not be loaded."));
    return () => {
      live = false;
    };
  }, []);

  async function decide(id: string, verb: "approve" | "revoke") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/deletions/${id}/${verb}`, {});
      setNotice(verb === "approve" ? "Approved. It will be deleted only when a deletion run is started." : "Approval withdrawn.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  const empty = list.approved.length === 0 && list.candidates.length === 0;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <span className="section-label">STAGING DELETIONS</span>
      <h2>Records the tool created</h2>
      <p className="subtle">
        Approve one record at a time. Only records this tool created, by exact id, can be approved. Approving only marks the record:
        nothing is deleted from Lawcus until a deletion run is started, and that run is not available in this app yet.
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {empty ? (
        <p className="subtle">No records are waiting for a deletion decision.</p>
      ) : (
        <div className="scenario-list">
          {list.approved.map((r) => (
            <div className="list-row" key={r.id} style={{ display: "block" }}>
              <div className="inline">
                <strong>{r.display_name ?? r.resource_id}</strong>
                <Badge variant="secondary">Approved for deletion</Badge>
              </div>
              <p className="subtle">
                {r.resource_type} · created {stamp(r.created_at)} · {r.resource_id}
              </p>
              <Button variant="outline" disabled={busy} onClick={() => void decide(r.id, "revoke")}>
                Withdraw approval
              </Button>
            </div>
          ))}
          {list.candidates.map((r) => (
            <div className="list-row" key={r.id} style={{ display: "block" }}>
              <div className="inline">
                <strong>{r.display_name ?? r.resource_id}</strong>
                <Badge variant="outline">Waiting for a decision</Badge>
              </div>
              <p className="subtle">
                {r.resource_type} · created {stamp(r.created_at)} · {r.resource_id}
              </p>
              <Button disabled={busy} onClick={() => void decide(r.id, "approve")}>
                Approve deletion
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
