"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { request } from "@/lib/qa-api";

type SignalRow = {
  id: string;
  kind: string;
  title: string;
  status: "new" | "analyzed" | "dismissed";
  source: string | null;
  receivedAt: string;
  affectedFacts: number | null;
  runnableTests: number | null;
};

type AffectedFact = { itemId: string; semanticId: string; feature: string; title: string; statement: string; basis: string; strength: number; because: string; matchedTerms?: string[] };
type PlannedCheck = { externalId: string; title: string; feature: string; risk: string; runnable: boolean; blockedReason: string | null; quarantineReason: string | null; reasons: { basis: string; because: string }[] };
type Analysis = { affectedFacts: AffectedFact[]; namedFeatures: string[]; regressionPlan: { run: PlannedCheck[]; blocked: PlannedCheck[] }; missingInformation: string[]; note: string };
type Signal = { id: string; kind: string; title: string; body: string; source: string | null; source_ref: string | null; occurred_at: string; received_at: string; submitted_by: string; status: SignalRow["status"]; analysis: Analysis | null };
type Diff = {
  revisions: { itemId: string; semanticId: string; version: number; status: string; before: string | null; after: string }[];
  flags: { id: string; knowledge_item_id: string; note: string | null; status: "open" | "resolved"; raised_by: string; resolution: string | null; resolution_note: string | null }[];
};

const KIND_LABEL: Record<string, string> = {
  qa_note: "QA note",
  requirement: "Requirement",
  design: "Design",
  api_spec: "API spec",
  release_note: "Release note",
  code_change: "Code change",
  observed_diff: "Observed difference",
};
const BASIS_LABEL: Record<string, string> = {
  cited: "Named in the signal",
  feature_named: "Its feature is named",
  term_overlap: "Loose word overlap",
  linked_to_fact: "Linked to a fact",
  same_feature: "Same feature",
  same_feature_weak: "Same feature (weak)",
  graph_neighbor: "Connected feature",
};
const STATE_LABEL = { new: "New", analyzed: "Analyzed", dismissed: "Dismissed" } as const;

const stamp = (value: string) =>
  new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function ChangeSignals() {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ signal: Signal; diff: Diff } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const detailPanel = useRef<HTMLDivElement>(null);

  const [kind, setKind] = useState("release_note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  const [sourceRef, setSourceRef] = useState("");

  const fetchList = useCallback(() => request<{ signals: SignalRow[]; kinds: string[] }>("/change-signals"), []);

  const loadList = useCallback(async () => {
    try {
      const result = await fetchList();
      setSignals(result.signals);
      setKinds(result.kinds);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The signals could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [fetchList]);

  const loadDetail = useCallback(async (id: string) => {
    setSelected(id);
    setDetail(null);
    try {
      setDetail(await request<{ signal: Signal; diff: Diff }>("/change-signals/" + id));
      setTimeout(() => detailPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That signal could not be loaded.");
    }
  }, []);

  // First load: results are applied after the request settles, never synchronously.
  useEffect(() => {
    let live = true;
    fetchList()
      .then((result) => {
        if (!live) return;
        setSignals(result.signals);
        setKinds(result.kinds);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "The signals could not be loaded."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fetchList]);

  // One wrapper for every action: clears notices, shows failures, refreshes.
  async function act(work: () => Promise<Outcome>, refreshDetailOf: string | null = selected) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outcome = await work();
      let open = refreshDetailOf;
      if (typeof outcome === "string") setNotice(outcome);
      else if (outcome) {
        setNotice(outcome.message);
        open = outcome.open;
      }
      await loadList();
      if (open) await loadDetail(open);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    await act(async () => {
      const result = await request<{ signal: Signal; duplicate: boolean }>("/change-signals", {
        kind,
        title,
        body,
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
      });
      if (!result.duplicate) {
        setTitle("");
        setBody("");
        setSource("");
        setSourceRef("");
      }
      return {
        message: result.duplicate ? "This exact text was already recorded, so the existing signal is shown." : "Recorded and analyzed. Nothing was changed.",
        open: result.signal.id,
      };
    }, null);
  }

  return (
    <div className="change-signals">
      <div className="panel">
        <span className="section-label">TELL THE AGENT WHAT CHANGED</span>
        <h2>Product changes</h2>
        <p className="subtle">
          Paste a release note, requirement, QA note or an observed difference. The agent works out which approved facts
          it may touch and which checks are worth re-running. It never changes a fact, a test or an expected result by
          itself; you decide.
        </p>
        <div className="inline">
          <label className="sr-only" htmlFor="signal-kind">
            Kind of change
          </label>
          <select id="signal-kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border, #d0d5dd)" }}>
            {(kinds.length ? kinds : Object.keys(KIND_LABEL)).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k] ?? k}
              </option>
            ))}
          </select>
          <Input aria-label="Title" placeholder="Title (one line)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <Textarea aria-label="What changed" rows={5} placeholder="What changed? Name the feature, or a fact ID such as BR-CONTACT-EMAIL-001, if you know it." value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} style={{ marginTop: 10 }} />
        <div className="inline" style={{ marginTop: 10 }}>
          <Input aria-label="Source" placeholder="Source (optional), e.g. Release 4.2 notes" value={source} onChange={(e) => setSource(e.target.value)} />
          <Input aria-label="Source link" placeholder="Link or ticket (optional)" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
        </div>
        <p className="small-note">Passwords, tokens and keys pasted here are masked before anything is saved.</p>
        <Button disabled={busy || !title.trim() || !body.trim()} onClick={() => void submit()}>
          {busy ? <LoaderCircle className="spin" /> : <Send />}
          Record and analyze
        </Button>
        {notice && (
          <p className="notice" role="status" style={{ marginTop: 12 }}>
            {notice}
          </p>
        )}
        {error && (
          <div className="notice error" role="alert" style={{ marginTop: 12 }}>
            <p>{error}</p>
          </div>
        )}
      </div>

      <div className="panel">
        <span className="section-label">RECORDED CHANGES</span>
        {loading && signals.length === 0 ? (
          <p className="subtle">Loading…</p>
        ) : signals.length === 0 ? (
          <p className="subtle">Nothing recorded yet.</p>
        ) : (
          <div className="scenario-list">
            {signals.map((signal) => (
              <button
                type="button"
                key={signal.id}
                className={"list-row" + (selected === signal.id ? " selected" : "")}
                onClick={() => void loadDetail(signal.id)}
                style={{ textAlign: "left", width: "100%", cursor: "pointer", background: "transparent" }}
              >
                <div>
                  <h3>{signal.title}</h3>
                  <p className="subtle">
                    {KIND_LABEL[signal.kind] ?? signal.kind} · {stamp(signal.receivedAt)}
                    {signal.source ? ` · ${signal.source}` : ""}
                  </p>
                  {signal.affectedFacts !== null && (
                    <p className="small-note">
                      {signal.affectedFacts} fact{signal.affectedFacts === 1 ? "" : "s"} may be affected · {signal.runnableTests} check
                      {signal.runnableTests === 1 ? "" : "s"} to re-run
                    </p>
                  )}
                </div>
                <Badge variant="outline">{STATE_LABEL[signal.status]}</Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="panel" aria-live="polite" ref={detailPanel}>
          {!detail ? <p className="subtle">Loading…</p> : <SignalDetail detail={detail} busy={busy} act={act} />}
        </div>
      )}
    </div>
  );
}

type Outcome = string | void | { message: string; open: string };
type Act = (work: () => Promise<Outcome>, refreshDetailOf?: string | null) => Promise<void>;

function SignalDetail({ detail, busy, act }: { detail: { signal: Signal; diff: Diff }; busy: boolean; act: Act }) {
  const { signal, diff } = detail;
  const analysis = signal.analysis;
  const [revising, setRevising] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [flagging, setFlagging] = useState<string | null>(null);
  const [flagNote, setFlagNote] = useState("");
  const [resolveNote, setResolveNote] = useState("");
  const dismissed = signal.status === "dismissed";

  return (
    <div>
      <div className="panel-heading">
        <div>
          <span className="section-label">
            {KIND_LABEL[signal.kind] ?? signal.kind} · {stamp(signal.received_at)} · {signal.submitted_by}
          </span>
          <h2>{signal.title}</h2>
        </div>
        <Badge variant="outline">{STATE_LABEL[signal.status]}</Badge>
      </div>
      <p style={{ whiteSpace: "pre-wrap" }}>{signal.body}</p>
      {(signal.source || signal.source_ref) && (
        <p className="subtle">
          Source: {signal.source ?? ""} {signal.source_ref ?? ""}
        </p>
      )}
      <div className="inline">
        <Button variant="outline" disabled={busy || dismissed} onClick={() => void act(async () => { await request(`/change-signals/${signal.id}/analyze`, {}); return "Analysis refreshed."; })}>
          Analyze again
        </Button>
        <Button variant="outline" disabled={busy || dismissed} onClick={() => void act(async () => { await request(`/change-signals/${signal.id}/dismiss`, {}); return "Dismissed. It will not be analyzed again."; })}>
          Dismiss
        </Button>
      </div>

      {analysis && (
        <>
          <h3 style={{ marginTop: 20 }}>Facts this may touch</h3>
          {analysis.affectedFacts.length === 0 ? (
            <p className="subtle">No known feature or approved fact matched. Say which feature this concerns, or it cannot be tied to any check.</p>
          ) : (
            <div className="scenario-list">
              {analysis.affectedFacts.map((fact) => (
                <div className="list-row" key={fact.itemId} style={{ display: "block" }}>
                  <div className="inline" style={{ justifyContent: "space-between" }}>
                    <h3>{fact.title}</h3>
                    <Badge variant="outline">{BASIS_LABEL[fact.basis] ?? fact.basis}</Badge>
                  </div>
                  <p className="subtle">
                    {fact.feature} · {fact.semanticId}
                  </p>
                  <p>{fact.statement}</p>
                  <p className="small-note">{fact.because}</p>
                  {!dismissed && (
                    <div className="inline">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setRevising(revising === fact.itemId ? null : fact.itemId); setRevision(fact.statement); setFlagging(null); }}>
                        Propose a revision
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setFlagging(flagging === fact.itemId ? null : fact.itemId); setFlagNote(""); setRevising(null); }}>
                        Flag for re-review
                      </Button>
                    </div>
                  )}
                  {revising === fact.itemId && (
                    <div style={{ marginTop: 10 }}>
                      <Textarea aria-label="Revised statement" rows={3} value={revision} maxLength={2000} onChange={(e) => setRevision(e.target.value)} />
                      <p className="small-note">This is filed as a pending revision. The approved statement stays in force until you approve the revision in the Knowledge tab.</p>
                      <Button size="sm" disabled={busy || !revision.trim()} onClick={() => void act(async () => {
                        const result = await request<{ unchanged: boolean }>(`/change-signals/${signal.id}/propose-revision`, { semanticId: fact.semanticId, statement: revision.trim() });
                        setRevising(null);
                        return result.unchanged ? "That is the same statement, so nothing was proposed." : "Revision filed as pending. Review it in the Knowledge tab.";
                      })}>
                        File revision
                      </Button>
                    </div>
                  )}
                  {flagging === fact.itemId && (
                    <div style={{ marginTop: 10 }}>
                      <Input aria-label="Why this fact may be out of date" placeholder="Why might this fact be out of date? (optional)" value={flagNote} onChange={(e) => setFlagNote(e.target.value)} />
                      <p className="small-note">A flag is a reminder. The fact stays approved and no check changes.</p>
                      <Button size="sm" disabled={busy} onClick={() => void act(async () => {
                        await request(`/change-signals/${signal.id}/flag`, { itemId: fact.itemId, ...(flagNote.trim() ? { note: flagNote.trim() } : {}) });
                        setFlagging(null);
                        return "Flagged for re-review.";
                      })}>
                        Flag it
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <h3 style={{ marginTop: 20 }}>Checks worth re-running</h3>
          <PlannedChecks title="Can run now" checks={analysis.regressionPlan.run} empty="No runnable check was selected." />
          {analysis.regressionPlan.blocked.length > 0 && (
            <PlannedChecks title="Selected but cannot run" checks={analysis.regressionPlan.blocked} empty="" />
          )}

          {analysis.missingInformation.length > 0 && (
            <>
              <h3 style={{ marginTop: 20 }}>What is missing</h3>
              <ul>
                {analysis.missingInformation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <p className="small-note">{analysis.note}</p>
        </>
      )}

      {diff.revisions.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>Proposed revisions</h3>
          <div className="scenario-list">
            {diff.revisions.map((rev) => (
              <div className="list-row" key={rev.itemId} style={{ display: "block" }}>
                <div className="inline" style={{ justifyContent: "space-between" }}>
                  <h3>
                    {rev.semanticId} · version {rev.version}
                  </h3>
                  <Badge variant="outline">{rev.status.replaceAll("_", " ")}</Badge>
                </div>
                <p className="subtle">Before</p>
                <p style={{ textDecoration: "line-through", opacity: 0.75 }}>{rev.before ?? "(no earlier approved statement)"}</p>
                <p className="subtle">After</p>
                <p>{rev.after}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {diff.flags.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>Review flags</h3>
          <div className="scenario-list">
            {diff.flags.map((flag) => (
              <div className="list-row" key={flag.id} style={{ display: "block" }}>
                <div className="inline" style={{ justifyContent: "space-between" }}>
                  <p>
                    {flag.note ?? "Flagged for re-review."} <span className="subtle">· {flag.raised_by}</span>
                  </p>
                  <Badge variant="outline">{flag.status === "open" ? "Open" : `Resolved: ${flag.resolution?.replaceAll("_", " ")}`}</Badge>
                </div>
                {flag.status === "open" && (
                  <div className="inline">
                    <Input aria-label="Resolution note" placeholder="Note (optional)" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} />
                    {(["still_valid", "revised", "obsolete"] as const).map((resolution) => (
                      <Button key={resolution} size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
                        await request(`/change-signals/flags/${flag.id}/resolve`, { resolution, ...(resolveNote.trim() ? { note: resolveNote.trim() } : {}) });
                        setResolveNote("");
                        return "Flag resolved.";
                      })}>
                        {resolution === "still_valid" ? "Still valid" : resolution === "revised" ? "Revised" : "Obsolete"}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PlannedChecks({ title, checks, empty }: { title: string; checks: PlannedCheck[]; empty: string }) {
  return (
    <div>
      <span className="section-label">{title.toUpperCase()}</span>
      {checks.length === 0 ? (
        <p className="subtle">{empty}</p>
      ) : (
        <div className="scenario-list">
          {checks.map((check) => (
            <div className="list-row" key={check.externalId} style={{ display: "block" }}>
              <div className="inline" style={{ justifyContent: "space-between" }}>
                <h3>{check.title}</h3>
                <Badge variant="outline">{check.runnable ? "runs" : check.blockedReason === "quarantined" ? "quarantined" : "not approved"}</Badge>
              </div>
              <p className="subtle">
                {check.feature} · {check.externalId}
              </p>
              {check.quarantineReason && (
                <p className="small-note">
                  <AlertTriangle size={12} /> {check.quarantineReason}
                </p>
              )}
              {check.reasons.map((reason) => (
                <p className="small-note" key={reason.because}>
                  {BASIS_LABEL[reason.basis] ?? reason.basis}: {reason.because}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
