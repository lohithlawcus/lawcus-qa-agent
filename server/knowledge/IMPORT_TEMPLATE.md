# Knowledge Bulk-Import Template

Paste a document like this into the "BULK-IMPORT KNOWLEDGE" box on the
Knowledge tab. Every item and relationship still lands as **pending review**
in the Knowledge Inbox, exactly like a single hand-written proposal — nothing
here is ever auto-approved.

Rules:
- One field per line, exactly `Key: value` — no multi-line values. Keep each
  Statement to one clear sentence (that's the point of "one record = one
  atomic fact").
- `## Feature: <name>` starts a feature group. The first time a feature name
  appears, it needs a `Description:` line right after it. Reusing the same
  feature name later in the file (or in a future import) does not need the
  description repeated.
- `### <TYPE>: <SEMANTIC-ID>` starts one Knowledge item. The semantic ID must
  follow its type's prefix convention (BR-, FIELD-, PERM-, DEP-, WF-, API-,
  UI-, DATA-, ENV-, LIMIT-, CHANGE-, INT-, VAL-, CALC-, SEC-, EDGE-) and end in
  a 3-digit number, e.g. `BR-BILLING-LATE-FEE-001`.
- `Scope:` (optional) is only for a fact that holds for some roles,
  configurations, tenants or environments and not others, e.g.
  `Scope: roles=admin,owner; environments=lawcus`. Allowed keys: `roles`,
  `configurations`, `tenants`, `environments`, each a comma-separated list;
  separate keys with semicolons; one `Scope:` line per item. Leave the line out
  for a fact that applies everywhere. The same statement with a different scope
  is a different fact; adding a scope to a fact that already exists files a
  pending revision of it. An empty scope, an unknown key, or a repeated line
  fails the whole import. Relationships have no scope.
- `### EDGE: <EDGE_TYPE>` starts a relationship between two features that
  must already exist (created earlier in this file, or already in the
  system).
- Every Knowledge item needs a `Source Title:` (its `Source URL:` is optional): a
  fact with nothing supporting it is refused. Relationships may leave it out.
- Any typo, unknown type, invalid semantic ID, or bad Provenance value fails
  the *entire* import with a line number — nothing partial ever gets
  proposed.
- `Related Tests` must name a TestBook case that already exists (a real
  foreign key, unlike every other field here) — an unknown one fails the
  whole import too, just without a line number, since that check only
  happens once everything else has already parsed correctly.

---

## Feature: Billing
Description: Invoicing, time entries and payments for a matter.

### BUSINESS_RULE: BR-BILLING-TIMEKEEPER-REQUIRED-001
Title: An invoice needs at least one timekeeper on the matter
Provenance: DOCUMENTED
Statement: A matter must have at least one timekeeper assigned before an invoice can be generated for it.
Does Not Mean: This does not require the timekeeper to have logged any billable time yet.
Applies To: existing_matter
Scope: roles=owner,admin; environments=lawcus
Source Title: Lawcus Support — Billing overview
Source URL: https://support.lawcus.com/en/articles/example-billing-overview
Release: 2026.09

### FIELD_RULE: FIELD-BILLING-INVOICE-NUMBER-UNIQUE-001
Title: Invoice numbers are unique per firm
Provenance: DOCUMENTED
Statement: An invoice number must be unique within the firm; Lawcus rejects a duplicate invoice number.
Source Title: Example source (replace with the real one)

### EDGE: DEPENDS_ON
From: Billing
To: Contacts
Rationale: An invoice is always billed to a Contact record.

## Feature: Matters
Description: The core case/file record everything else (billing, contacts, documents) attaches to.

### VALIDATION_RULE: VAL-MATTERS-NAME-REQUIRED-001
Title: A matter must have a name
Provenance: DOCUMENTED
Statement: Creating a matter without a name is blocked by required-field validation.
Source Title: Example source (replace with the real one)

### EDGE: DEPENDS_ON
From: Billing
To: Matters
Rationale: Every invoice belongs to exactly one matter.
