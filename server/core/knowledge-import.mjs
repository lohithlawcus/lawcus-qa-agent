import { TYPE_PREFIXES, PROVENANCE_VALUES, validateSemanticId, KnowledgeError } from "./knowledge.mjs";

// V5 "efficiently update our knowledge base" (2026-09-18) — a plain-text
// bulk-authoring format for knowledge.mjs's existing proposeItem/proposeEdge,
// so a human can write many Business Rules/Field Rules/Dependencies/etc. in
// one file instead of one at a time through hand-written JS (the only path
// that existed before this). This module only ever produces PROPOSALS —
// every item/edge it returns still goes through proposeItem()/proposeEdge()
// exactly as today, landing as pending_review for a human to approve. It
// never approves anything itself (same discipline as every other propose
// path in this project).
//
// Format (see server/knowledge/IMPORT_TEMPLATE.md for a filled-in example):
//
//   ## Feature: <name>
//   Description: <required the first time this feature name appears>
//
//   ### <TYPE>: <SEMANTIC-ID>
//   Title: <short title>
//   Provenance: <PRODUCT_APPROVED|DOCUMENTED|OBSERVED|INFERRED|ASSUMED|DEPRECATED>
//   Statement: <the one atomic fact, one line>
//   Does Not Mean: <optional>
//   Applies To: <optional, comma-separated>
//   Preconditions: <optional, comma-separated>
//   Source Title: <optional>
//   Source URL: <optional>
//   Related Tests: <optional, comma-separated TestBook external ids>
//   API Contracts: <optional, comma-separated API contract semantic ids>
//   Release: <optional>
//   Effective From: <optional>
//   Effective Until: <optional>
//
//   ### EDGE: <EDGE_TYPE>
//   From: <feature name>
//   To: <feature name>
//   Rationale: <why this relationship is real>
//   Source Title: <optional>
//   Source URL: <optional>
//
// Deliberately one field per line, no multi-line continuation: an atomic
// Knowledge fact (guide section 3) is meant to be short, and a fixed
// one-line-per-field shape means a stray colon in prose can never be
// misread as the start of a new field — every line is either a recognized
// field or a hard parse error, never a guess.

const EDGE_TYPES = new Set([
  "DEPENDS_ON", "USED_BY", "AFFECTS", "SHARED_MODEL", "REQUIRES_PERMISSION",
  "BACKED_BY_API", "TESTED_BY", "CREATES", "CONVERTS_TO", "REFERENCES", "TRIGGERS",
]);

const ITEM_KEYS = new Set([
  "title", "provenance", "statement", "does not mean", "applies to", "preconditions",
  "source title", "source url", "related tests", "api contracts", "release",
  "effective from", "effective until",
]);
const EDGE_KEYS = new Set(["from", "to", "rationale", "source title", "source url"]);

function splitList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Parses the bulk-import Markdown into proposeItem()/proposeEdge()-ready
 * objects plus a list of line-numbered errors. Never partially valid: the
 * caller is expected to propose nothing at all if errors.length > 0 (fail
 * closed on a broken batch, rather than importing half of it). */
export function parseKnowledgeMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const edges = [];
  const errors = [];
  let currentFeature = null;
  let current = null;

  function finalizeCurrent() {
    if (!current) return;
    const f = current.fields;
    if (current.kind === "item") {
      const { type, semanticId, lineNo } = current;
      let typeOk = !!TYPE_PREFIXES[type];
      if (!typeOk) {
        errors.push({
          line: lineNo,
          message: `Unknown Knowledge type "${type}". Valid types: ${Object.keys(TYPE_PREFIXES).join(", ")}.`,
        });
      } else {
        try {
          validateSemanticId(type, semanticId);
        } catch (error) {
          typeOk = false;
          errors.push({ line: lineNo, message: error instanceof KnowledgeError ? error.message : String(error) });
        }
      }
      const provenance = f.get("provenance");
      const provenanceOk = provenance && PROVENANCE_VALUES.includes(provenance);
      if (!provenanceOk)
        errors.push({
          line: lineNo,
          message: `"${semanticId}": Provenance must be one of ${PROVENANCE_VALUES.join(", ")} (got "${provenance ?? "(missing)"}").`,
        });
      if (!f.get("title")) errors.push({ line: lineNo, message: `"${semanticId}": missing "Title:".` });
      if (!f.get("statement")) errors.push({ line: lineNo, message: `"${semanticId}": missing "Statement:".` });
      if (!currentFeature)
        errors.push({ line: lineNo, message: `"${semanticId}" has no enclosing "## Feature:" heading.` });
      else if (!currentFeature.description)
        errors.push({
          line: lineNo,
          message: `Feature "${currentFeature.name}" needs a "Description:" line the first time it's introduced.`,
        });

      if (typeOk && provenanceOk && f.get("title") && f.get("statement") && currentFeature?.description) {
        const sourceTitle = f.get("source title");
        items.push({
          semanticId,
          type,
          featureName: currentFeature.name,
          featureDescription: currentFeature.description,
          title: f.get("title"),
          statement: f.get("statement"),
          doesNotMean: f.get("does not mean") || null,
          provenance,
          source: sourceTitle ? { title: sourceTitle, url: f.get("source url") || null, author: null } : null,
          appliesTo: f.has("applies to") ? splitList(f.get("applies to")) : null,
          preconditions: f.has("preconditions") ? splitList(f.get("preconditions")) : null,
          relatedTests: f.has("related tests") ? splitList(f.get("related tests")) : [],
          apiContracts: f.has("api contracts") ? splitList(f.get("api contracts")) : [],
          release: f.get("release") || null,
          effectiveFrom: f.get("effective from") || null,
          effectiveUntil: f.get("effective until") || null,
        });
      }
    } else if (current.kind === "edge") {
      const { type, lineNo } = current;
      const typeOk = EDGE_TYPES.has(type);
      if (!typeOk)
        errors.push({ line: lineNo, message: `Unknown edge type "${type}". Valid types: ${[...EDGE_TYPES].join(", ")}.` });
      const from = f.get("from");
      const to = f.get("to");
      const rationale = f.get("rationale");
      if (!from) errors.push({ line: lineNo, message: `EDGE ${type}: missing "From:".` });
      if (!to) errors.push({ line: lineNo, message: `EDGE ${type}: missing "To:".` });
      if (!rationale) errors.push({ line: lineNo, message: `EDGE ${type}: missing "Rationale:".` });
      if (typeOk && from && to && rationale) {
        const sourceTitle = f.get("source title");
        edges.push({
          type,
          fromFeatureName: from,
          toFeatureName: to,
          rationale,
          source: sourceTitle ? { title: sourceTitle, url: f.get("source url") || null, author: null } : null,
        });
      }
    }
    current = null;
  }

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const featureMatch = /^##\s*Feature:\s*(.+)$/i.exec(trimmed);
    if (featureMatch) {
      finalizeCurrent();
      currentFeature = { name: featureMatch[1].trim(), description: null };
      return;
    }
    const descMatch = /^Description:\s*(.*)$/i.exec(trimmed);
    if (descMatch && currentFeature && !current) {
      currentFeature.description = descMatch[1].trim();
      return;
    }
    const headingMatch = /^###\s*([A-Za-z_]+)\s*:\s*(.+)$/.exec(trimmed);
    if (headingMatch) {
      finalizeCurrent();
      const [, headType, rest] = headingMatch;
      if (headType.toUpperCase() === "EDGE") current = { kind: "edge", lineNo, type: rest.trim(), fields: new Map() };
      else current = { kind: "item", lineNo, type: headType.toUpperCase(), semanticId: rest.trim(), fields: new Map() };
      return;
    }
    if (!current) {
      errors.push({ line: lineNo, message: `Line outside any "### TYPE: id" or "### EDGE: TYPE" block: "${trimmed}"` });
      return;
    }
    const kvMatch = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(trimmed);
    const validKeys = current.kind === "item" ? ITEM_KEYS : EDGE_KEYS;
    if (kvMatch && validKeys.has(kvMatch[1].trim().toLowerCase())) {
      current.fields.set(kvMatch[1].trim().toLowerCase(), kvMatch[2].trim());
      return;
    }
    errors.push({
      line: lineNo,
      message: kvMatch
        ? `Unrecognized field "${kvMatch[1].trim()}:" for this ${current.kind === "edge" ? "EDGE" : current.type}. Valid fields: ${[...validKeys].join(", ")}.`
        : `Line inside a block must be "Key: value": "${trimmed}"`,
    });
  });
  finalizeCurrent();

  return { items, edges, errors };
}
