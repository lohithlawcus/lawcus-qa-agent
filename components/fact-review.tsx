"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/qa-api";

type DerivedStatus =
  | "current"
  | "under_review"
  | "stale"
  | "pending"
  | "rejected"
  | "retired_duplicate"
  | "superseded"
  | "deprecated";

type FactRow = {
  semanticId: string;
  id: string;
  title: string;
  feature: string | null;
  type: string;
  derivedStatus: DerivedStatus;
  provenance: string;
  authorityKind: "expected" | "observed_or_inferred";
  hasSource: boolean;
  scoped: boolean;
  testCount: number;
  decidedBy: string | null;
  decidedAt: string | null;
};

type FactCard = {
  id: string;
  semanticId: string;
  version: number;
  feature: string | null;
  type: string;
  title: string;
  statement: string;
  doesNotMean: string | null;
  status: string;
  derivedStatus: DerivedStatus;
  authority: { provenance: string; rank: number; kind: "expected" | "observed_or_inferred" };
  source: { title: string; url: string | null; author: string | null; ingestedAt: string } | null;
  evidenceGap: boolean;
  approval: { by: string | null; at: string | null; note: string | null } | null;
  appliesWhere: {
    scope: Record<string, string[]> | null;
    unscoped: boolean;
    recordKinds: string[] | null;
    preconditions: string[] | null;
    expectedBehavior: Record<string, Record<string, string>> | null;
    effectiveFrom: string | null;
    effectiveUntil: string | null;
    release: string | null;
  };
  assertedByTests: { externalId: string; title?: string; runnable?: boolean; status?: string; quarantineReason?: string | null; missing?: boolean }[];
  apiContracts: string[];
  supersession: { supersededBy: { id: string; version: number } | null; supersedes: string | null };
  history: { id: string; version: number; status: string; provenance: string; statement: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null }[];
  pendingRevisions: { id: string; version: number; statement: string }[];
  openReviewFlags: { id: string; note: string | null; raisedAt: string; signal: string }[];
  aliases: { semanticId: string; reason: string; since: string }[];
};

type StaleFact = { itemId: string; semanticId: string; feature: string; title: string; provenance: string; reasons: string[] };

const STATUS_LABEL: Record<DerivedStatus, string> = {
  current: "Current",
  under_review: "Under review",
  stale: "Stale",
  pending: "Pending",
  rejected: "Rejected",
  retired_duplicate: "Retired duplicate",
  superseded: "Superseded",
  deprecated: "Deprecated",
};

const FILTERS: (DerivedStatus | "all")[] = ["all", "current", "pending", "under_review", "stale", "superseded", "rejected", "retired_duplicate"];

const stamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

function AuthorityBadge({ kind, provenance }: { kind: "expected" | "observed_or_inferred"; provenance: string }) {
  return (
    <Badge variant="outline" title={kind === "expected" ? "A rule someone owns or documented" : "Seen on a tenant or inferred; not an owned rule"}>
      {kind === "expected" ? "Expected" : "Observed / inferred"} · {provenance.replaceAll("_", " ").toLowerCase()}
    </Badge>
  );
}

export function FactReview() {
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [unsourced, setUnsourced] = useState(0);
  const [stale, setStale] = useState<StaleFact[]>([]);
  const [filter, setFilter] = useState<DerivedStatus | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [card, setCard] = useState<FactCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const cardPanel = useRef<HTMLDivElement>(null);

  const fetchAll = useCallback(async () => {
    const [list, staleResult] = await Promise.all([
      request<{ facts: FactRow[]; unsourced: number }>("/knowledge/facts"),
      request<{ facts: StaleFact[] }>("/knowledge/stale"),
    ]);
    return { list, staleResult };
  }, []);

  const apply = useCallback((result: { list: { facts: FactRow[]; unsourced: number }; staleResult: { facts: StaleFact[] } }) => {
    setFacts(result.list.facts);
    setUnsourced(result.list.unsourced);
    setStale(result.staleResult.facts);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      apply(await fetchAll());
    } catch (e) {
      setError(e instanceof Error ? e.message : "The facts could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [apply, fetchAll]);

  // First load: results are applied after the request settles, never synchronously.
  useEffect(() => {
    let live = true;
    fetchAll()
      .then((result) => live && apply(result))
      .catch((e) => live && setError(e instanceof Error ? e.message : "The facts could not be loaded."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fetchAll, apply]);

  const open = useCallback(async (ref: string) => {
    setSelected(ref);
    setCard(null);
    setError("");
    try {
      const result = await request<{ fact: FactCard }>("/knowledge/facts/" + encodeURIComponent(ref));
      setCard(result.fact);
      // The card opens below a long list; bring it into view once it has rendered.
      setTimeout(() => cardPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That fact could not be loaded.");
    }
  }, []);

  const counts = facts.reduce<Record<string, number>>((acc, fact) => {
    acc[fact.derivedStatus] = (acc[fact.derivedStatus] || 0) + 1;
    return acc;
  }, {});
  const shown = facts.filter((fact) => filter === "all" || fact.derivedStatus === filter);

  return (
    <div className="fact-review">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-label">EVERY RULE, WITH ITS EVIDENCE</span>
            <h2>Facts</h2>
          </div>
          <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
            {loading ? <LoaderCircle className="spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>
        <p className="subtle">
          Open a fact to see who approved it, where it applies, what supports it, which tests assert it, and whether it
          has been replaced. Observed evidence is never shown as an owned rule.
        </p>
        {error && (
          <div className="notice error" role="alert">
            <p>{error}</p>
          </div>
        )}
        {unsourced > 0 && (
          <div className="notice" role="status">
            <AlertTriangle size={16} />
            <p>
              {unsourced} fact{unsourced === 1 ? " has" : "s have"} no source recorded (older records). They are marked
              &ldquo;No source&rdquo; below so a reviewer can decide how far to trust them.
            </p>
          </div>
        )}
        <div className="inline" role="group" aria-label="Filter facts by state">
          {FILTERS.filter((f) => f === "all" || counts[f]).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
              {f === "all" ? `All (${facts.length})` : `${STATUS_LABEL[f]} (${counts[f]})`}
            </Button>
          ))}
        </div>
        {loading && facts.length === 0 ? (
          <p className="subtle">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="subtle">No facts in this state.</p>
        ) : (
          <div className="scenario-list">
            {shown.map((fact) => (
              <button
                type="button"
                className={"list-row fact-row" + (selected === fact.id || selected === fact.semanticId ? " selected" : "")}
                key={fact.id}
                onClick={() => void open(fact.id)}
                style={{ textAlign: "left", width: "100%", cursor: "pointer", background: "transparent" }}
              >
                <div>
                  <h3>{fact.title}</h3>
                  <p className="subtle">
                    {fact.feature} · {fact.semanticId}
                  </p>
                  <div className="inline">
                    <AuthorityBadge kind={fact.authorityKind} provenance={fact.provenance} />
                    {!fact.hasSource && <Badge variant="outline">No source</Badge>}
                    {fact.scoped && <Badge variant="outline">Scoped</Badge>}
                    <Badge variant="outline">
                      {fact.testCount} test{fact.testCount === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </div>
                <Badge variant="outline">{STATUS_LABEL[fact.derivedStatus]}</Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      {stale.length > 0 && (
        <div className="panel">
          <span className="section-label">WORTH LOOKING AT AGAIN</span>
          <p className="subtle">Approved facts that are volatile by nature and have not been reviewed for a while, or are past their end date.</p>
          <div className="scenario-list">
            {stale.map((fact) => (
              <button
                type="button"
                className="list-row"
                key={fact.itemId}
                onClick={() => void open(fact.itemId)}
                style={{ textAlign: "left", width: "100%", cursor: "pointer", background: "transparent" }}
              >
                <div>
                  <h3>{fact.title}</h3>
                  <p className="subtle">
                    {fact.feature} · {fact.semanticId}
                  </p>
                </div>
                <span className="small-note">{fact.reasons.join("; ")}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div className="panel" aria-live="polite" ref={cardPanel}>
          {!card ? (
            <p className="subtle">Loading the fact…</p>
          ) : (
            <FactCardView card={card} onOpen={(ref) => void open(ref)} />
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <span className="section-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function FactCardView({ card, onOpen }: { card: FactCard; onOpen: (ref: string) => void }) {
  const where = card.appliesWhere;
  return (
    <div>
      <div className="panel-heading">
        <div>
          <span className="section-label">
            {card.feature} · {card.type.replaceAll("_", " ")} · version {card.version}
          </span>
          <h2>{card.title}</h2>
        </div>
        <Badge variant="outline">{STATUS_LABEL[card.derivedStatus]}</Badge>
      </div>
      <p>{card.statement}</p>
      {card.doesNotMean && <p className="subtle">Does not mean: {card.doesNotMean}</p>}
      <div className="inline">
        <AuthorityBadge kind={card.authority.kind} provenance={card.authority.provenance} />
        <Badge variant="outline">{card.semanticId}</Badge>
      </div>

      {card.supersession.supersededBy && (
        <div className="notice" role="status">
          <p>
            Replaced by version {card.supersession.supersededBy.version}.{" "}
            <button type="button" className="link-button" onClick={() => onOpen(card.supersession.supersededBy!.id)}>
              Open the current fact
            </button>
          </p>
        </div>
      )}

      <Field label="WHO APPROVED IT">
        {card.approval && card.approval.by ? (
          <p>
            {card.approval.by} · {stamp(card.approval.at)}
            {card.approval.note ? ` — “${card.approval.note}”` : ""}
          </p>
        ) : (
          <p className="subtle">{card.status === "pending_review" ? "Not decided yet." : "No decision recorded."}</p>
        )}
      </Field>

      <Field label="WHAT SUPPORTS IT">
        {card.source ? (
          <p>
            {card.source.url ? (
              <a href={card.source.url} target="_blank" rel="noreferrer">
                {card.source.title}
              </a>
            ) : (
              card.source.title
            )}
            {card.source.author ? ` · ${card.source.author}` : ""}
          </p>
        ) : (
          <div className="notice" role="status">
            <AlertTriangle size={16} />
            <p>No source is recorded for this fact. Treat it with care until one is added.</p>
          </div>
        )}
      </Field>

      <Field label="WHERE IT APPLIES">
        {where.unscoped ? <p>Everywhere (no scope is set).</p> : (
          <p>
            {Object.entries(where.scope || {})
              .map(([key, values]) => `${key}: ${values.join(", ")}`)
              .join(" · ")}
          </p>
        )}
        {where.recordKinds && where.recordKinds.length > 0 && <p className="subtle">Record kinds: {where.recordKinds.join(", ")}</p>}
        {where.preconditions && where.preconditions.length > 0 && <p className="subtle">Preconditions: {where.preconditions.join("; ")}</p>}
        {(where.effectiveFrom || where.effectiveUntil || where.release) && (
          <p className="subtle">
            {where.effectiveFrom ? `From ${where.effectiveFrom}` : ""}
            {where.effectiveUntil ? ` until ${where.effectiveUntil}` : ""}
            {where.release ? ` · release ${where.release}` : ""}
          </p>
        )}
      </Field>

      <Field label="WHICH TESTS ASSERT IT">
        {card.assertedByTests.length === 0 ? (
          <p className="subtle">No test is linked to this fact, so nothing proves it after a change.</p>
        ) : (
          <div className="scenario-list">
            {card.assertedByTests.map((test) => (
              <div className="list-row" key={test.externalId}>
                <div>
                  <h3>{test.title ?? test.externalId}</h3>
                  <p className="subtle">{test.externalId}</p>
                  {test.quarantineReason && <p className="small-note">Quarantined: {test.quarantineReason}</p>}
                </div>
                <Badge variant="outline">{test.missing ? "not found" : test.runnable ? "runs" : "does not run"}</Badge>
              </div>
            ))}
          </div>
        )}
        {card.apiContracts.length > 0 && <p className="subtle">API contracts: {card.apiContracts.join(", ")}</p>}
      </Field>

      {card.openReviewFlags.length > 0 && (
        <Field label="FLAGGED FOR REVIEW">
          {card.openReviewFlags.map((flag) => (
            <p key={flag.id}>
              Because of &ldquo;{flag.signal}&rdquo;{flag.note ? ` — ${flag.note}` : ""} ({stamp(flag.raisedAt)})
            </p>
          ))}
        </Field>
      )}

      {card.pendingRevisions.length > 0 && (
        <Field label="REVISIONS WAITING FOR REVIEW">
          {card.pendingRevisions.map((revision) => (
            <p key={revision.id}>
              Version {revision.version}: {revision.statement}
            </p>
          ))}
        </Field>
      )}

      <Field label="HISTORY">
        <div className="scenario-list">
          {card.history.map((version) => (
            <div className="list-row" key={version.id}>
              <div>
                <h3>Version {version.version}</h3>
                <p>{version.statement}</p>
                <p className="subtle">
                  {version.provenance.replaceAll("_", " ").toLowerCase()}
                  {version.decidedBy ? ` · ${version.decidedBy} · ${stamp(version.decidedAt)}` : ""}
                  {version.decisionNote ? ` — “${version.decisionNote}”` : ""}
                </p>
              </div>
              <Badge variant="outline">{version.status.replaceAll("_", " ")}</Badge>
            </div>
          ))}
        </div>
      </Field>

      {card.aliases.length > 0 && (
        <Field label="ALSO KNOWN AS">
          <p>{card.aliases.map((alias) => alias.semanticId).join(", ")}</p>
        </Field>
      )}
    </div>
  );
}
