import { AlertTriangle, Ban, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type PlanBlocker = { kind: string; detail: string; feature?: string; externalId?: string };
export type PlanReviewRequest = { kind: string; severity: "info" | "review" | "refused"; message: string };

/** What a plan built from approved knowledge has to say beyond its checks:
 * whether it can run, what blocks it, which relations are waiting for a
 * person to approve, and what it deliberately left out. */
export type PlanNoticeData = {
  origin?: string;
  status?: string;
  blockers?: PlanBlocker[];
  reviewRequests?: PlanReviewRequest[];
  uncoveredFeatures?: string[];
  outOfScopeFacts?: number;
  reviewFlags?: { flag_id: string; semantic_id: string; title: string; signal_title: string }[];
};

export const isBlocked = (plan: PlanNoticeData | null | undefined) => plan?.status === "blocked";

export function PlanNotices({ plan }: { plan: PlanNoticeData }) {
  const blockers = plan.blockers ?? [];
  const requests = plan.reviewRequests ?? [];
  const flags = plan.reviewFlags ?? [];
  const uncovered = plan.uncoveredFeatures ?? [];
  if (!blockers.length && !requests.length && !flags.length && !uncovered.length && !plan.outOfScopeFacts) return null;

  return (
    <div className="plan-notices">
      {blockers.length > 0 && (
        <div className="notice error" role="alert">
          <Ban size={16} />
          <div>
            <p>
              <strong>This plan cannot run yet.</strong> Nothing will be started until these are resolved:
            </p>
            <ul>
              {blockers.map((blocker, i) => (
                <li key={i}>{blocker.detail}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {requests.map((request, i) => (
        <div className={"notice" + (request.severity === "refused" ? " error" : "")} role="status" key={i}>
          {request.severity === "info" ? <Info size={16} /> : <AlertTriangle size={16} />}
          <p>
            {request.severity === "review" && <Badge variant="outline">Needs your review</Badge>}{" "}
            {request.message}
          </p>
        </div>
      ))}
      {uncovered.length > 0 && (
        <div className="notice" role="status">
          <Info size={16} />
          <p>No checks exist yet for: {uncovered.join(", ")}. They are affected by this request but not covered.</p>
        </div>
      )}
      {flags.length > 0 && (
        <div className="notice" role="status">
          <AlertTriangle size={16} />
          <p>
            {flags.length} fact{flags.length === 1 ? "" : "s"} this plan relies on {flags.length === 1 ? "is" : "are"} flagged for re-review (
            {flags.map((f) => f.semantic_id).join(", ")}). The plan still runs; the flag is a reminder.
          </p>
        </div>
      )}
      {!!plan.outOfScopeFacts && (
        <p className="small-note">
          {plan.outOfScopeFacts} approved fact{plan.outOfScopeFacts === 1 ? " applies" : "s apply"} only to another role,
          configuration or environment and {plan.outOfScopeFacts === 1 ? "was" : "were"} not used.
        </p>
      )}
    </div>
  );
}
