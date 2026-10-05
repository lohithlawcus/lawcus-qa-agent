"use client";

import { useEffect, useState } from "react";
import { request } from "@/lib/qa-api";

type Attempt = { at: string; ageDays: number; status: string; failureClass: string | null; reasonCode: string | null; codeRevision: string | null };
type CaseRow = {
  externalId: string;
  title: string;
  feature: string;
  state: string;
  countsAsCoverage: boolean;
  quarantineReason: string | null;
  stagingRuns: number;
  lastAttempt: Attempt | null;
  lastConclusive: Attempt | null;
  newerInconclusiveAttempt: boolean;
};
type Report = {
  generatedAt: string;
  staleAfterDays: number;
  states: Record<string, string>;
  summary: { cases: number; byState: Record<string, number>; coveredCases: number };
  cases: CaseRow[];
  quality: {
    windowDays: number;
    note: string;
    checks: { executed: number; passed: number; failed: number };
    failuresByClass: Record<string, number>;
    functionalShareOfFailures: number | null;
    functionalShareBasis: number;
    runOutcomes: Record<string, number>;
    flakyCases: string[];
  };
};

// Plain-English labels and one-line reasons for each state. Kept in step with the
// states the coverage report returns; the report's own explanations stay the source of truth.
const STATE = {
  covered: { label: "Counts as coverage", tone: "good", why: "Passed recently, and that is the latest result that counts." },
  stale: { label: "Stale", tone: "warn", why: "Last passed more than 14 days ago. Run it again to refresh it." },
  failing: { label: "Failing", tone: "bad", why: "The latest result that counts is a failure." },
  inconclusive: { label: "Never conclusive", tone: "warn", why: "Every attempt was blocked, so nothing counts yet." },
  never_run_on_staging: { label: "Never run on staging", tone: "muted", why: "Not run on the staging tenant yet." },
  quarantined: { label: "Quarantined", tone: "muted", why: "Known broken automation, held back on purpose." },
  not_approved: { label: "Not approved", tone: "muted", why: "Waiting for approval, so it isn't used yet." },
} as const;
type StateKey = keyof typeof STATE;

// Needs attention comes first and opens by default; the other lanes stay folded until asked for.
const LANES: { title: string; hint: string; states: StateKey[]; open: boolean }[] = [
  { title: "Needs attention", hint: "Something here needs a re-run or a look.", states: ["failing", "stale", "inconclusive"], open: true },
  { title: "Counts as coverage", hint: "These are what we can point to today.", states: ["covered"], open: false },
  { title: "Not counted yet", hint: "Not run, held back, or waiting for approval.", states: ["never_run_on_staging", "quarantined", "not_approved"], open: false },
];

const CLASS_LABEL: Record<string, string> = {
  functional: "Lawcus behaved differently",
  infrastructure: "Environment",
  automation: "Could not drive the page",
  integrity: "Could not save",
  unclassified: "Unrecognised",
  unlabelled: "Recorded before failures were classified",
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function Ring({ value, total }: { value: number; total: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const share = total ? value / total : 0;
  return (
    <svg viewBox="0 0 128 128" width="128" height="128" role="img" aria-label={`${value} of ${total} checks count as coverage`}>
      <circle cx="64" cy="64" r={r} fill="none" stroke="var(--cov-track, #e6ece9)" strokeWidth="12" />
      <circle
        cx="64"
        cy="64"
        r={r}
        fill="none"
        stroke="var(--cov-fill, #12624e)"
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${c * share} ${c}`}
        transform="rotate(-90 64 64)"
      />
      <text x="64" y="62" textAnchor="middle" className="ring-number">{value}</text>
      <text x="64" y="82" textAnchor="middle" className="ring-of">of {total}</text>
    </svg>
  );
}

export function CoverageReport() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    request<Report>("/coverage")
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "The coverage report could not be loaded."));
    return () => {
      live = false;
    };
  }, []);

  if (error)
    return (
      <div className="ui-card">
        <div className="notice error" role="alert">
          <p>{error}</p>
        </div>
      </div>
    );
  if (!report) return <div className="ui-card"><p className="subtle">Loading the coverage report…</p></div>;

  const { summary, quality } = report;
  const failureTotal = Object.values(quality.failuresByClass).reduce((a, b) => a + b, 0);
  const attention = report.cases.filter((c) => LANES[0].states.includes(c.state as StateKey)).length;
  return (
    <section className="ui-stack">
      <div className="ui-hero">
        <Ring value={summary.coveredCases} total={summary.cases} />
        <div className="ui-hero-text">
          <span className="section-label">WHAT COUNTS TODAY</span>
          <h2>What counts as coverage today</h2>
          <p>
            <strong>{summary.coveredCases} of {summary.cases} checks count as coverage</strong> on the main staging tenant. A check counts when its latest result that counts is a pass within {report.staleAfterDays} days.
          </p>
          <div className="ui-chips" aria-label="Checks by state">
            {(Object.keys(STATE) as StateKey[])
              .filter((k) => (summary.byState[k] ?? 0) > 0)
              .map((k) => (
                <span key={k} className={`ui-chip ui-chip-${STATE[k].tone}`}>
                  {summary.byState[k]} {STATE[k].label.toLowerCase()}
                </span>
              ))}
          </div>
          <p className="ui-next">
            {attention === 0
              ? "Nothing needs attention right now."
              : `${attention} ${attention === 1 ? "check needs" : "checks need"} a re-run or a look. Start with Needs attention below.`}
          </p>
        </div>
      </div>

      <div className="ui-lanes">
        {LANES.map((lane) => {
          const rows = report.cases.filter((c) => lane.states.includes(c.state as StateKey));
          return (
            <details className="ui-card ui-fold" key={lane.title} open={lane.open}>
              <summary className="ui-card-head">
                <h3>{lane.title}</h3>
                <span className="ui-count">{rows.length}</span>
              </summary>
              <p className="subtle">{lane.hint}</p>
              {rows.length === 0 ? (
                <p className="subtle ui-empty">Nothing here.</p>
              ) : (
                <ul className="ui-list">
                  {rows.map((c) => {
                    const meta = STATE[c.state as StateKey];
                    return (
                      <li key={c.externalId} className="ui-row">
                        <div className="ui-row-top">
                          <code className="ui-code">{c.externalId}</code>
                          <span className={`ui-chip ui-chip-${meta.tone}`}>{meta.label}</span>
                        </div>
                        <p className="ui-row-meta">
                          {c.feature} · {c.stagingRuns} staging run{c.stagingRuns === 1 ? "" : "s"}
                          {c.lastConclusive ? ` · last counted result ${c.lastConclusive.status} on ${day(c.lastConclusive.at)}` : ""}
                        </p>
                        <p className="ui-row-why">{meta.why}</p>
                        {c.newerInconclusiveAttempt && c.lastAttempt && (
                          <p className="ui-row-note">A newer attempt on {day(c.lastAttempt.at)} did not count ({c.lastAttempt.reasonCode ?? c.lastAttempt.failureClass ?? "blocked"}).</p>
                        )}
                        {c.quarantineReason && <p className="ui-row-note">{c.quarantineReason}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </details>
          );
        })}
      </div>

      <details className="ui-card ui-fold">
        <summary className="ui-card-head">
          <h3>Quality baseline, last {quality.windowDays} days</h3>
        </summary>
        <p className="subtle">{quality.note}</p>
        <div className="ui-tiles">
          <div className="ui-tile"><strong>{quality.checks.executed}</strong><span>checks ran on real tenants</span></div>
          <div className="ui-tile good"><strong>{quality.checks.passed}</strong><span>passed</span></div>
          <div className="ui-tile bad"><strong>{quality.checks.failed}</strong><span>failed</span></div>
        </div>
        <p className="ui-row-why">
          {quality.functionalShareOfFailures === null
            ? "None of the failures were recorded with a cause, so the share that are about Lawcus cannot be stated yet."
            : `${quality.functionalShareOfFailures}% of the ${quality.functionalShareBasis} classified failures say Lawcus behaved differently.`}
        </p>
        {failureTotal > 0 && (
          <ul className="ui-bars">
            {Object.entries(quality.failuresByClass)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <li key={k}>
                  <span className="ui-bar-label">{CLASS_LABEL[k] ?? k}</span>
                  <span className="ui-bar"><span style={{ width: `${Math.round((n / failureTotal) * 100)}%` }} /></span>
                  <span className="ui-bar-count">{n}</span>
                </li>
              ))}
          </ul>
        )}
        {quality.flakyCases.length > 0 && (
          <p className="ui-row-note">Passed and failed on the same code: {quality.flakyCases.join(", ")}</p>
        )}
      </details>
    </section>
  );
}
