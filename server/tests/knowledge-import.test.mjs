import test from "node:test";
import assert from "node:assert/strict";
import { parseKnowledgeMarkdown } from "../core/knowledge-import.mjs";

test("a well-formed document parses into proposeItem-ready items and proposeEdge-ready edges, with no errors", () => {
  const { items, edges, errors } = parseKnowledgeMarkdown(`
## Feature: Billing
Description: Invoicing, time entries and payments for a matter.

### BUSINESS_RULE: BR-BILLING-EXAMPLE-001
Title: Example rule
Provenance: DOCUMENTED
Statement: A matter must have at least one timekeeper before an invoice can be generated.
Does Not Mean: This does not require the timekeeper to have logged any time yet.
Applies To: existing_matter
Source Title: Lawcus Support - Billing overview
Source URL: https://support.lawcus.com/billing
Related Tests: billing.example_case
API Contracts: lawcus.billing.create_invoice
Release: 2026.09

### EDGE: DEPENDS_ON
From: Billing
To: Contacts
Rationale: An invoice is always billed to a Contact record.
`);
  assert.deepEqual(errors, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].semanticId, "BR-BILLING-EXAMPLE-001");
  assert.equal(items[0].featureName, "Billing");
  assert.deepEqual(items[0].appliesTo, ["existing_matter"]);
  assert.deepEqual(items[0].relatedTests, ["billing.example_case"]);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], {
    type: "DEPENDS_ON",
    fromFeatureName: "Billing",
    toFeatureName: "Contacts",
    rationale: "An invoice is always billed to a Contact record.",
    source: null,
  });
});

test("an item with no enclosing Feature heading is rejected, never silently dropped", () => {
  const { items, errors } = parseKnowledgeMarkdown(`
### BUSINESS_RULE: BR-ORPHAN-001
Title: Orphan rule
Provenance: DOCUMENTED
Statement: test
`);
  assert.equal(items.length, 0);
  assert.ok(errors.some((e) => /no enclosing/.test(e.message)));
});

test("a feature introduced without a Description line is rejected", () => {
  const { items, errors } = parseKnowledgeMarkdown(`
## Feature: Contacts
### BUSINESS_RULE: BR-CONTACTS-EXAMPLE-001
Title: Example
Provenance: DOCUMENTED
Statement: test
`);
  assert.equal(items.length, 0);
  assert.ok(errors.some((e) => /needs a "Description:"/.test(e.message)));
});

test("an unknown type, invalid semantic id, and invalid provenance are all reported, each with a line number", () => {
  const { errors } = parseKnowledgeMarkdown(`
## Feature: Contacts
Description: d

### NOT_A_TYPE: BR-CONTACTS-EXAMPLE-001
Title: Example
Provenance: DOCUMENTED
Statement: test

### FIELD_RULE: not-a-valid-id
Title: Example
Provenance: DOCUMENTED
Statement: test

### BUSINESS_RULE: BR-CONTACTS-EXAMPLE-002
Title: Example
Provenance: CONFIRMED
Statement: test
`);
  assert.ok(errors.some((e) => e.line === 5 && /Unknown Knowledge type/.test(e.message)));
  assert.ok(errors.some((e) => e.line === 10 && /naming convention/.test(e.message)));
  assert.ok(errors.some((e) => e.line === 15 && /Provenance must be one of/.test(e.message)));
});

test("an unrecognized field name inside a block is a hard error, never silently merged into another field", () => {
  // The item's own recognized fields are still valid, so the parser still
  // surfaces it — the real safety gate is the caller (server/index.mjs's
  // /knowledge/import route) refusing to propose anything while
  // errors.length > 0, checked separately below.
  const { errors } = parseKnowledgeMarkdown(`
## Feature: Contacts
Description: d

### BUSINESS_RULE: BR-CONTACTS-EXAMPLE-001
Title: Example
Provenance: DOCUMENTED
Statement: test
Typo Field: oops
`);
  assert.ok(errors.some((e) => /Unrecognized field "Typo Field:"/.test(e.message)));
});

test("a line outside any block is a hard error", () => {
  const { errors } = parseKnowledgeMarkdown(`Just some stray text with no heading at all.`);
  assert.ok(errors.some((e) => /outside any/.test(e.message)));
});

test("an EDGE block with an unknown type or missing required fields is rejected", () => {
  const { edges, errors } = parseKnowledgeMarkdown(`
### EDGE: NOT_A_REAL_EDGE_TYPE
From: A
To: B
Rationale: because

### EDGE: DEPENDS_ON
From: A
`);
  assert.equal(edges.length, 0);
  assert.ok(errors.some((e) => /Unknown edge type/.test(e.message)));
  assert.ok(errors.some((e) => /missing "To:"/.test(e.message)));
  assert.ok(errors.some((e) => /missing "Rationale:"/.test(e.message)));
});

// ---------- every fact needs a source (KB-03) ----------

const ITEM_WITHOUT_SOURCE = `## Feature: Billing
Description: Invoicing.

### BUSINESS_RULE: BR-BILLING-SRC-001
Title: A rule
Provenance: DOCUMENTED
Statement: A rule with nothing supporting it.
`;

test("an item with no Source Title is a line error, and nothing is returned for it", () => {
  const { items, errors } = parseKnowledgeMarkdown(ITEM_WITHOUT_SOURCE);
  assert.equal(items.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /"BR-BILLING-SRC-001": missing "Source Title:"/);
  assert.ok(errors[0].line > 0);
  assert.equal(parseKnowledgeMarkdown(`${ITEM_WITHOUT_SOURCE}Source Title: Release notes\n`).errors.length, 0);
});

test("a relationship may still omit its source (only facts need one)", () => {
  const text = `## Feature: A\nDescription: d\n\n## Feature: B\nDescription: d\n\n### EDGE: DEPENDS_ON\nFrom: A\nTo: B\nRationale: r\n`;
  assert.equal(parseKnowledgeMarkdown(text).errors.length, 0);
});

test("the shipped import template and the UI's example text both parse cleanly, so they cannot go stale", async () => {
  const { readFileSync } = await import("node:fs");
  const template = readFileSync(new URL("../knowledge/IMPORT_TEMPLATE.md", import.meta.url), "utf8");
  const body = template.slice(template.indexOf("---\n") + 4);
  const fromTemplate = parseKnowledgeMarkdown(body);
  assert.deepEqual(fromTemplate.errors.filter((e) => /Source Title/.test(e.message)), []);
  const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const example = page.match(/const EXAMPLE_KNOWLEDGE_TEXT = `([\s\S]*?)`;/)[1];
  const fromUi = parseKnowledgeMarkdown(example);
  assert.deepEqual(fromUi.errors, []);
  assert.ok(fromUi.items.length >= 1 && fromUi.items.every((item) => item.source?.title));
});
