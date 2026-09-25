// KB-04: plan a test request from APPROVED knowledge. The graph is directed:
// each edge type says which way a change flows and whether one feature needs
// the other set up first, instead of being read as an undirected "related to".
// Nothing here is guessed: a plan reports why each check is in it, lists what
// is missing as a blocker, and turns an unknown relation into a review request.

import { factApplies } from "./knowledge.mjs";
import { CASE_SETUP } from "../testbook/case-setup.mjs";

/**
 * impact:        how a CHANGE to one end reaches the other.
 *   forward  a change to the source affects the target
 *   reverse  a change to the target affects the source
 *   both     either way        none  informational only
 * prerequisite:  whether one end must be set up to test the other.
 *   from_requires_to  testing the source needs the target's data/configuration
 */
export const EDGE_SEMANTICS = {
  DEPENDS_ON: { impact: "reverse", prerequisite: "from_requires_to", meaning: "the source cannot work or be tested without the target" },
  REQUIRES_PERMISSION: { impact: "reverse", prerequisite: "from_requires_to", meaning: "the source needs a permission the target defines" },
  REFERENCES: { impact: "reverse", prerequisite: "from_requires_to", meaning: "the source points at records of the target" },
  BACKED_BY_API: { impact: "reverse", prerequisite: null, meaning: "the source is served by the target API" },
  USED_BY: { impact: "forward", prerequisite: null, meaning: "the source is used by the target" },
  AFFECTS: { impact: "forward", prerequisite: null, meaning: "a change to the source changes the target's behavior" },
  CREATES: { impact: "forward", prerequisite: null, meaning: "the source creates records of the target" },
  CONVERTS_TO: { impact: "forward", prerequisite: null, meaning: "records of the source become records of the target" },
  TRIGGERS: { impact: "forward", prerequisite: null, meaning: "the source starts the target" },
  SHARED_MODEL: { impact: "both", prerequisite: null, meaning: "the two share one data model" },
  TESTED_BY: { impact: "none", prerequisite: null, meaning: "informational" },
};

const describe = (edge) => `${edge.from_feature} ${edge.type} ${edge.to_feature}`;

/** Features a change to `changed` reaches, following edge direction only. */
export function impactedFeatures(edges, changed, maxHops = 3) {
  const reached = new Map();
  const seen = new Set([changed]);
  let frontier = [{ feature: changed, path: [] }];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next = [];
    for (const { feature, path } of frontier) {
      for (const edge of edges) {
        const semantics = EDGE_SEMANTICS[edge.type];
        if (!semantics) continue; // "none" matches neither direction below, so it reaches nothing
        const targets = [];
        if ((semantics.impact === "forward" || semantics.impact === "both") && edge.from_feature === feature) targets.push(edge.to_feature);
        if ((semantics.impact === "reverse" || semantics.impact === "both") && edge.to_feature === feature) targets.push(edge.from_feature);
        for (const target of targets) {
          if (seen.has(target)) continue;
          seen.add(target);
          const nextPath = [...path, edge];
          reached.set(target, { hops: hop + 1, path: nextPath, because: nextPath.map(describe).join(" → ") });
          next.push({ feature: target, path: nextPath });
        }
      }
    }
    frontier = next;
  }
  return reached;
}

/** What must be set up before the given features can be tested, in an order
 * that puts each prerequisite before whatever needs it. Reports cycles. */
export function prerequisiteClosure(edges, features) {
  const direct = new Map();
  for (const edge of edges) {
    if (EDGE_SEMANTICS[edge.type]?.prerequisite !== "from_requires_to") continue;
    if (!direct.has(edge.from_feature)) direct.set(edge.from_feature, []);
    direct.get(edge.from_feature).push({ prerequisite: edge.to_feature, edge });
  }
  const order = [];
  const cycles = [];
  const done = new Set();
  const visit = (feature, stack) => {
    if (stack.includes(feature)) {
      cycles.push([...stack.slice(stack.indexOf(feature)), feature]);
      return;
    }
    if (done.has(feature)) return;
    for (const { prerequisite } of direct.get(feature) || []) visit(prerequisite, [...stack, feature]);
    done.add(feature);
    order.push(feature);
  };
  for (const feature of features) visit(feature, []);
  const closureOf = (feature) => {
    const out = new Set();
    const walk = (f, seen) => {
      for (const { prerequisite } of direct.get(f) || []) {
        if (seen.has(prerequisite)) continue;
        out.add(prerequisite);
        walk(prerequisite, new Set([...seen, prerequisite]));
      }
    };
    walk(feature, new Set([feature]));
    return [...out];
  };
  return { order, cycles, direct, closureOf };
}

const TESTING_REQUEST = /\b(?:test|tests|testing|verify|verifies|check|checks|validate|validation|regression|re-?run|cover|coverage)\b/i;
const DESTRUCTIVE_REQUEST = /\b(?:delete|deletes|deleting|remove|drop|purge|wipe|destroy|erase|truncate|merge|bulk)\b/i;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Builds a plan from approved knowledge for a request that names a feature.
 * `status` is "ready" only when at least one check can run and nothing the
 * plan needs is missing; otherwise "blocked", with every blocker listed.
 */
export function planFromKnowledge({ intent, knowledge, testbook, caseSetup = CASE_SETUP, context = { environments: ["lawcus"] } }) {
  const normalizedIntent = String(intent ?? "").trim().replace(/\s+/g, " ");
  const empty = (reviewRequests) => ({
    origin: "graph", matched: false, normalizedIntent, status: "not_planned", features: [], knowledgeItems: [], reviewFlags: [],
    cells: [], gaps: [], quarantined: [], setup: [], blockers: [], reviewRequests, cycles: [],
  });

  // A destructive request is never turned into a plan, and a request that is not
  // asking for a test is not guessed into one.
  if (DESTRUCTIVE_REQUEST.test(normalizedIntent)) {
    return empty([{ kind: "not_a_testing_request", severity: "refused", message: "This request asks for something destructive. Only testing requests are planned; nothing was selected." }]);
  }
  if (!TESTING_REQUEST.test(normalizedIntent)) {
    return empty([{ kind: "not_a_testing_request", severity: "info", message: "This does not read as a request to test, verify or check something, so no plan was made. Say which feature to test." }]);
  }

  const tree = testbook.tree();
  const subjects = tree.filter((feature) => new RegExp(`\\b${escapeRegExp(feature.name)}\\b`, "i").test(normalizedIntent)).map((feature) => feature.name);
  if (!subjects.length) {
    return empty([{ kind: "unknown_feature", severity: "review", message: `No known feature is named in this request. Known features: ${tree.map((f) => f.name).join(", ") || "none"}.` }]);
  }

  const approvedEdges = knowledge.approvedGraph();
  const impacted = new Map(); // feature -> { role, because }
  for (const subject of subjects) impacted.set(subject, { role: "subject", because: `Named in the request.` });
  for (const subject of subjects) {
    for (const [feature, info] of impactedFeatures(approvedEdges, subject)) {
      if (!impacted.has(feature)) impacted.set(feature, { role: "impacted", because: `Impacted by a change to ${subject}: ${info.because}.` });
    }
  }
  const scopeFeatures = [...impacted.keys()];
  const prerequisites = prerequisiteClosure(approvedEdges, scopeFeatures);

  // Which checks, and can each be run?
  const casesByFeature = new Map(tree.map((feature) => [feature.name, feature.suites.flatMap((suite) => suite.cases)]));
  const orderRank = new Map(prerequisites.order.map((feature, index) => [feature, index]));
  const cells = [];
  const setup = [];
  const blockers = [];
  const uncoveredFeatures = [];
  for (const feature of [...scopeFeatures].sort((a, b) => (orderRank.get(a) ?? 1e6) - (orderRank.get(b) ?? 1e6) || a.localeCompare(b))) {
    const cases = casesByFeature.get(feature) || [];
    if (!cases.length) {
      uncoveredFeatures.push(feature);
      if (impacted.get(feature).role === "subject") blockers.push({ kind: "no_cases", feature, detail: `"${feature}" has no test cases at all.` });
      continue;
    }
    const needs = prerequisites.closureOf(feature);
    for (const testCase of cases) {
      const declared = caseSetup[testCase.externalId] || {};
      const satisfied = needs.map((prerequisite) => ({
        prerequisite,
        mode: (declared.selfProvisions || []).includes(prerequisite)
          ? "self_provisioned"
          : (declared.usesFixtures || []).includes(prerequisite)
            ? "existing_fixture"
            : declared.needsNoSetup === true
              ? "not_needed"
              : "unmet",
      }));
      const unmet = satisfied.filter((entry) => entry.mode === "unmet").map((entry) => entry.prerequisite);
      let blockedReason = null;
      if (testCase.status !== "approved") blockedReason = "not_approved";
      else if (!testCase.runnable) blockedReason = "quarantined";
      else if (unmet.length) blockedReason = "prerequisite_unmet";
      for (const entry of satisfied) setup.push({ externalId: testCase.externalId, ...entry });
      if (unmet.length) blockers.push({ kind: "prerequisite_unmet", feature, externalId: testCase.externalId, detail: `"${testCase.externalId}" needs ${unmet.map((u) => `"${u}"`).join(", ")} set up, but the check neither creates it nor declares an existing fixture for it.` });
      cells.push({
        featureName: feature, recordState: "impacted", externalId: testCase.externalId, role: impacted.get(feature).role,
        covered: blockedReason === null, blockedReason, testCaseId: testCase.id ?? null, currentVersion: testCase.currentVersion ?? null,
        reasons: [impacted.get(feature).because],
        prerequisites: satisfied,
      });
    }
  }
  for (const cycle of prerequisites.cycles) blockers.push({ kind: "dependency_cycle", detail: `The approved dependencies form a cycle: ${cycle.join(" → ")}.` });
  if (!cells.some((cell) => cell.covered)) blockers.push({ kind: "nothing_runnable", detail: "No selected check can run (none exist, or all are quarantined, unapproved or blocked)." });

  // Relations nobody has approved are review requests, never guesses.
  const reviewRequests = [];
  const pending = knowledge.inboxEdges();
  for (const subject of subjects) {
    const touching = pending.filter((edge) => edge.from_feature === subject || edge.to_feature === subject);
    for (const edge of touching) {
      reviewRequests.push({ kind: "pending_edge", severity: "review", edgeId: edge.id, message: `Not used in this plan: ${edge.from_feature} ${edge.type} ${edge.to_feature} is proposed but not approved yet.` });
    }
    const hasApproved = approvedEdges.some((edge) => edge.from_feature === subject || edge.to_feature === subject);
    if (!hasApproved && !touching.length) {
      reviewRequests.push({ kind: "no_known_relations", severity: "info", message: `No approved relation is known for "${subject}". If other features depend on it, or it depends on them, propose those relations for review; this plan covers "${subject}" alone.` });
    }
  }

  const items = knowledge
    .approvedByFeature()
    .filter((group) => impacted.has(group.feature))
    .flatMap((group) => group.items);
  const applicable = items.filter((item) => factApplies(item, context));
  const status = blockers.length ? "blocked" : "ready";

  return {
    origin: "graph",
    matched: true,
    patternId: "graph",
    normalizedIntent,
    subjectFeatureName: subjects[0],
    status,
    features: scopeFeatures,
    impact: scopeFeatures.map((feature) => ({ feature, ...impacted.get(feature) })),
    knowledgeItems: applicable,
    outOfScopeFacts: items.length - applicable.length,
    reviewFlags: knowledge.openReviewFlags?.(applicable.map((item) => item.id)) ?? [],
    cells,
    gaps: [],
    quarantined: cells.filter((cell) => cell.blockedReason === "quarantined"),
    uncoveredFeatures,
    setup,
    prerequisiteOrder: prerequisites.order,
    cycles: prerequisites.cycles,
    blockers,
    reviewRequests,
  };
}
