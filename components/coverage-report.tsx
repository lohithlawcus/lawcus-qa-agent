"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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

const STATE_LABEL: Record<string, string> = {
  covered: "Counts as coverage",
  stale: "Stale",
  failing: "Failing",
  inconclusive: "Never conclusive",
  never_run_on_staging: "Never run on staging",
  quarantined: "Quarantined",
  not_approved: "Not approved",
};
const CLASS_LABEL: Record<string, string> = {
  functional: "Lawcus behaved differently",
  infrastructure: "Environment",
  automation: "Could not drive the page",
  integrity: "Could not save",
  unclassified: "Unrecognised",
  unlabelled: "Recorded before failures were classified",
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

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
      <div className="panel">
        <div className="notice error" role="alert">
          <p>{error}</p>
        </div>
      </div>
    );
  if (!report) return <div className="panel"><p className="subtle">Loading the coverage report…</p></div>;

  const { summary, quality } = report;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <span className="section-label">FROM THE RUN HISTORY</span>
      <h2>What counts as coverage today</h2>
      <p className="subtle">
        {summary.coveredCases} of {summary.cases} checks count as coverage on the main staging tenant: their last result that counts is a pass
        within {report.staleAfterDays} days. Everything else is listed with why it does not.
      </p>
      <div className="scenario-list">
        {report.cases.map((c) => (
          <div className="list-row" key={c.externalId} style={{ display: "block" }}>
            <div className="inline">
              <strong>{c.externalId}</strong>
              <Badge variant={c.countsAsCoverage ? "secondary" : "outline"}>{STATE_LABEL[c.state] ?? c.state}</Badge>
            </div>
            <p className="subtle">
              {c.feature} · {c.stagingRuns} staging run{c.stagingRuns === 1 ? "" : "s"}
              {c.lastConclusive ? ` · last result that counts: ${c.lastConclusive.status} on ${day(c.lastConclusive.at)}` : ""}
              {c.newerInconclusiveAttempt && c.lastAttempt ? ` · a newer attempt on ${day(c.lastAttempt.at)} did not count (${c.lastAttempt.reasonCode ?? c.lastAttempt.failureClass ?? "blocked"})` : ""}
              {c.quarantineReason ? ` · ${c.quarantineReason}` : ""}
            </p>
          </div>
        ))}
      </div>
      <h3 style={{ marginTop: 20 }}>Quality baseline, last {quality.windowDays} days</h3>
      <p className="subtle">{quality.note}</p>
      <p>
        {quality.checks.executed} checks ran on real tenants: {quality.checks.passed} passed, {quality.checks.failed} failed.
        {quality.functionalShareOfFailures === null
          ? " None of the failures were recorded with a cause, so the share that are about Lawcus cannot be stated yet."
          : ` ${quality.functionalShareOfFailures}% of the ${quality.functionalShareBasis} classified failures say Lawcus behaved differently.`}
      </p>
      <ul>
        {Object.entries(quality.failuresByClass)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => (
            <li key={k}>
              {CLASS_LABEL[k] ?? k}: {n}
            </li>
          ))}
      </ul>
      {quality.flakyCases.length > 0 && <p>Passed and failed on the same code: {quality.flakyCases.join(", ")}</p>}
    </div>
  );
}
