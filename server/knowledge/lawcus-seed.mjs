// V5 Step 9 seed data for the Knowledge Base + Impact Graph, rewritten to
// match the operator's LAWCUS_QA_KNOWLEDGE_BASE_GUIDE.md exactly:
// semantic IDs follow its section 30 prefix convention (BR-/FIELD-/PERM-/
// WF-/VAL-/CALC-/SEC-/ENV-/LIMIT-/INT-/EDGE-/FEATURE-), and items carry
// its structured fields (applies_to, expected_behavior, api_contracts,
// related_tests) wherever this project has genuine, defensible content to
// put there -- never invented to fill out the template (guide section 39:
// "Do not overdocument"). Most items here are single, declarative facts
// from a support article with no existing/new distinction to structure,
// so expected_behavior/preconditions are left null on those; only the two
// items that explicitly discuss it get a structured expected_behavior.
//
// "authentication" entries are extracted directly from this project's own
// implemented, tested behavior (server/dsl/login/*.yaml,
// server/core/primitives.mjs, and the explicit product decisions recorded
// in migration 003_environment_confirmation.sql) — provenance DOCUMENTED
// or PRODUCT_APPROVED as noted per item, no external source. Each one
// links related_tests to the real TestBook case that proves it (real FKs
// to test_cases.external_id -- section 30's "link every important rule to
// tests whenever coverage exists").
//
// "contacts", "leads" and "contact-custom-fields" entries are extracted
// from official Lawcus support articles (support.lawcus.com), supplied by
// the operator on 2026-09-15. Every item cites its exact source article
// and carries provenance DOCUMENTED. None of this is approved — every
// item enters as pending_review for the operator to review (section 28's
// ingestion flow: Document -> candidate Knowledge -> PENDING_REVIEW ->
// human review -> Approve/Edit/Reject).
//
// This is a starting extraction, not exhaustive coverage of the source
// articles — it captures clearly-stated, unambiguous rules. Nuances left
// out here can be added as further proposals once this batch is reviewed.

const LAWCUS_SUPPORT = (title, url) => ({ title, url, author: "Lawcus Support" });

export const AUTHENTICATION_ITEMS = [
  {
    semanticId: "FIELD-AUTH-PASSWORD-MASKED-001",
    type: "FIELD_RULE",
    title: "Login password field masks input",
    statement:
      "The login page's password field must mask typed characters (never render them as plain text).",
    provenance: "DOCUMENTED",
    relatedTests: ["auth.password_masked"],
  },
  {
    semanticId: "VAL-AUTH-EMPTY-CREDENTIALS-001",
    type: "VALIDATION_RULE",
    title: "Empty login credentials are blocked client-side",
    statement:
      "Submitting the login form with an empty email and/or password must be blocked by required-field validation: no login request is sent, and the browser stays on the login page, unauthenticated.",
    provenance: "DOCUMENTED",
    relatedTests: ["auth.empty_fields"],
  },
  {
    semanticId: "BR-AUTH-LOGIN-IDENTITY-CHECK-001",
    type: "BUSINESS_RULE",
    title: "A successful login must be proven by workspace + account identity, not URL alone",
    statement:
      "A login attempt counts as successful only when the authenticated workspace is shown AND the dedicated test account's identity is confirmed (e.g. via the profile menu).",
    doesNotMean:
      "A URL change away from the login page, by itself, is not sufficient evidence that login succeeded.",
    provenance: "DOCUMENTED",
    relatedTests: ["auth.valid_login"],
    apiContracts: ["lawcus.auth.login"],
  },
  {
    semanticId: "BR-AUTH-LOGOUT-LOCAL-SESSION-001",
    type: "BUSINESS_RULE",
    title: "Logout must return to login and block the protected workspace in that browser",
    statement:
      "After logout, the same browser must return to the login page and must not be able to reopen the protected workspace by navigating directly to it.",
    doesNotMean:
      "This proves only that the local browser session was invalidated — it is not evidence of server-wide token revocation across other sessions/devices.",
    provenance: "DOCUMENTED",
    relatedTests: ["auth.logout"],
  },
  {
    semanticId: "SEC-AUTH-DEDICATED-ACCOUNT-001",
    type: "SECURITY_RULE",
    title: "Live staging login tests use only the dedicated QA test account",
    statement:
      "Automated login tests against live Lawcus staging must use only the operator's dedicated QA test account, whose identity is verified via the profile menu before its credentials are saved.",
    provenance: "PRODUCT_APPROVED",
  },
  {
    semanticId: "ENV-AUTH-NO-MFA-SSO-CAPTCHA-001",
    type: "ENVIRONMENT_RULE",
    title: "Staging login has no MFA, SSO, or CAPTCHA (product-confirmed)",
    statement:
      "The authorized Lawcus staging login flow has been confirmed by the product owner to present no MFA challenge, no SSO redirect, and no CAPTCHA.",
    provenance: "PRODUCT_APPROVED",
  },
  {
    semanticId: "LIMIT-AUTH-INVALID-PASSWORD-001",
    type: "KNOWN_LIMITATION",
    title: "Incorrect-password testing is disabled by default against live staging",
    statement:
      "Testing an incorrect password against live Lawcus staging is disabled by default (negativeAllowed=false) until the account's lockout/retry-limit policy is confirmed with the product owner. It remains enabled against the local synthetic fixture.",
    provenance: "PRODUCT_APPROVED",
    relatedTests: ["auth.invalid_password"],
  },
];

export const CONTACTS_ITEMS = [
  {
    semanticId: "BR-CONTACTS-PERSON-OR-COMPANY-001",
    type: "BUSINESS_RULE",
    title: "A contact is either a Person or a Company",
    statement:
      "Every contact in Lawcus is created as one of two types: Person (an individual) or Company (an organization/business). The New Contact form lets the operator switch between the two before saving.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT(
      "How to Add a New Contact, Edit and Delete a Contact in Lawcus?",
      "https://support.lawcus.com/en/articles/5010122-how-to-add-a-new-contact-edit-and-delete-a-contact-in-lawcus",
    ),
  },
  {
    semanticId: "FIELD-CONTACTS-PERSON-REQUIRED-001",
    type: "FIELD_RULE",
    title: "Required fields for a Person contact",
    statement:
      "For a new Person contact, Name is mandatory. Gender, Date of Birth, Emails, and Phone Numbers are collected as basic details; a person may have multiple emails/phone numbers, with exactly one designated primary.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT(
      "How to Add a New Contact, Edit and Delete a Contact in Lawcus?",
      "https://support.lawcus.com/en/articles/5010122-how-to-add-a-new-contact-edit-and-delete-a-contact-in-lawcus",
    ),
  },
  {
    semanticId: "FIELD-CONTACTS-COMPANY-REQUIRED-001",
    type: "FIELD_RULE",
    title: "Required fields for a Company contact",
    statement:
      "For a new Company contact, Name is mandatory. Emails and Phone Numbers are collected, and may have multiple values with exactly one primary each.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT(
      "How to Add a New Contact, Edit and Delete a Contact in Lawcus?",
      "https://support.lawcus.com/en/articles/5010122-how-to-add-a-new-contact-edit-and-delete-a-contact-in-lawcus",
    ),
  },
  {
    semanticId: "VAL-CONTACTS-SINGLE-VALUE-001",
    type: "VALIDATION_RULE",
    title: "A contact's sole email/phone/address cannot be deleted",
    statement:
      "When a contact has exactly one email, one phone number, or one address, that value is automatically treated as primary and cannot be deleted. Once additional values exist, all but the primary can be removed.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    preconditions: ["Contact has exactly one email, phone number, or address"],
    source: LAWCUS_SUPPORT(
      "How to Add, Edit, Delete Leads, and Convert them into Matters in Lawcus.",
      "https://support.lawcus.com/en/articles/5010123-how-to-add-edit-delete-leads-and-convert-them-into-matters-in-lawcus",
    ),
  },
  {
    semanticId: "BR-CONTACTS-DELETE-PERMANENT-001",
    type: "BUSINESS_RULE",
    title: "Deleting a contact is permanent; its invoices/matters/transactions are not deleted",
    statement:
      "Deleting a contact permanently removes the contact's own information and notes and cannot be undone. Any Invoices, Matters, and Transactions the contact was linked to remain in the system, but are no longer linked to the deleted contact.",
    doesNotMean:
      "Deleting a contact does not delete that contact's invoices, matters, or transactions — those records survive, unlinked.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT(
      "How to Add a New Contact, Edit and Delete a Contact in Lawcus?",
      "https://support.lawcus.com/en/articles/5010122-how-to-add-a-new-contact-edit-and-delete-a-contact-in-lawcus",
    ),
  },
  {
    semanticId: "BR-CONTACTS-DUPLICATE-DETECTION-001",
    type: "BUSINESS_RULE",
    title: "Contacts are flagged as duplicates by matching Name, Email, or Phone",
    statement:
      "Lawcus flags two contacts as possible duplicates when they share a matching Name, Email, or Phone Number. The Contacts page's \"Check Duplicates\" action surfaces these for review.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT("How to Merge Contacts?", "https://support.lawcus.com/en/articles/10503562-how-to-merge-contacts"),
  },
  {
    semanticId: "BR-CONTACTS-MERGE-PERMANENT-001",
    type: "BUSINESS_RULE",
    title: "Merging contacts is permanent and cannot be reversed",
    statement:
      "When two contacts are merged, the contact whose Name field was selected becomes the Primary Contact and the other is merged into it. All associated matters/leads, calendar events, and invoices are updated to the primary contact, and the merged (non-primary) contact's Client Portal access is removed. Once confirmed, the merge cannot be undone.",
    doesNotMean:
      "Merging does not preserve the non-primary contact as a separate, restorable record.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT("How to Merge Contacts?", "https://support.lawcus.com/en/articles/10503562-how-to-merge-contacts"),
  },
  {
    semanticId: "BR-CONTACTS-THREE-VIEWS-001",
    type: "BUSINESS_RULE",
    title: "Contacts are organized into All Contacts, Potential Clients (Leads), and Clients",
    statement:
      "The Contacts area has three views: All Contacts (every contact), Potential Clients (leads not yet associated with a matter), and Clients (contacts associated with at least one matter). A contact's related Leads do not themselves appear in the Contacts list, but their related contacts do.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact", "lead"],
    source: LAWCUS_SUPPORT(
      "Understanding Contact Views in Lawcus: All Contacts, Clients, and Potential Clients",
      "https://support.lawcus.com/en/articles/15003046-understanding-contact-views-in-lawcus-all-contacts-clients-and-potential-clients",
    ),
  },
  {
    semanticId: "PERM-CONTACTS-BULK-UPDATE-ROLE-001",
    type: "PERMISSION_RULE",
    title: "Bulk Update / Download / Delete of contacts requires Owner, Admin, or explicit custom permission",
    statement:
      "Bulk Update, Download, and Delete of contacts are available by default only to the Owner and Admin roles. A Custom Role can bulk-update contacts only if that permission is explicitly enabled for it; Download and Delete remain Owner/Admin-only regardless. Member, Co-counsel, and Client roles cannot bulk update, download, or delete contacts.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT("Bulk Update Contacts", "https://support.lawcus.com/en/articles/16250701-bulk-update-contacts"),
  },
  {
    semanticId: "VAL-CONTACTS-BULK-REFERRED-BY-001",
    type: "VALIDATION_RULE",
    title: "Bulk-updating Referred By always requires a value; Lead Source can be cleared",
    statement:
      "In Bulk Update, the Lead Source field can be cleared by selecting \"None\". The Referred By field cannot be cleared through Bulk Update — a valid contact must always be selected when updating it in bulk.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact"],
    source: LAWCUS_SUPPORT("Bulk Update Contacts", "https://support.lawcus.com/en/articles/16250701-bulk-update-contacts"),
  },
  {
    semanticId: "FIELD-CONTACTS-REFERRED-BY-001",
    type: "FIELD_RULE",
    title: "The Referred By field records who referred a contact, and works the same for Leads",
    statement:
      "The Referred By field on a contact identifies which other contact referred them. The contact named in Referred By gains a Referrals section listing everyone who named them as referrer (shown only once at least one referral exists). The same field and behavior apply to Leads.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact", "lead"],
    source: LAWCUS_SUPPORT(
      "Record and Track Contact Referrals in Lawcus",
      "https://support.lawcus.com/en/articles/16446939-record-and-track-contact-referrals-in-lawcus",
    ),
  },
];

export const LEADS_ITEMS = [
  {
    semanticId: "BR-LEADS-POTENTIAL-CLIENT-001",
    type: "BUSINESS_RULE",
    title: "A Lead is a potential client not yet associated with a Matter",
    statement:
      "A Lead represents an individual or organization who may become a client. Leads themselves do not appear in the main Contacts list, but their related contacts do.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead", "contact"],
    // Real, live-verified in this project (Step 15): GET /matters/:uuid
    // returns a Lead as a Matter-shaped record whose client_id links it to
    // exactly the Contact this rule describes.
    apiContracts: ["lawcus.leads.read"],
    source: LAWCUS_SUPPORT(
      "How to View Leads, Lead Details, and the Features Associated with Lead Interface?",
      "https://support.lawcus.com/en/articles/5010172-how-to-view-leads-lead-details-and-the-features-associated-with-lead-interface",
    ),
  },
  {
    semanticId: "WF-LEADS-DEFAULT-PIPELINE-001",
    type: "WORKFLOW_RULE",
    title: "Leads default to a four-stage Intake pipeline, which is customizable",
    statement:
      "By default, the Intake pipeline has four stages: Prospect, Initial Consultation, Follow-up, and Sign Agreement. Stages can be added, renamed, reordered, or removed. Removing a stage closes and archives every matter/lead currently in that stage.",
    doesNotMean:
      "Removing a stage does not delete the underlying lead or contact records — it closes and archives the associated matters.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead"],
    source: LAWCUS_SUPPORT("How to Manage Lead Stages in Lawcus?", "https://support.lawcus.com/en/articles/5010170-how-to-manage-lead-stages-in-lawcus"),
  },
  {
    semanticId: "LIMIT-LEADS-WORKFLOW-STAGE-MOVE-001",
    type: "KNOWN_LIMITATION",
    title: "A workflow cannot move a lead between pipeline stages or block its progression",
    statement:
      "Per the product's own FAQ, a lead cannot currently be moved from one pipeline stage to another via workflow automation, nor can a workflow block/prevent a lead's stage progression.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead"],
    source: LAWCUS_SUPPORT(
      "How to Manage Lead Stages in Lawcus?",
      "https://support.lawcus.com/en/articles/5010170-how-to-manage-lead-stages-in-lawcus",
    ),
  },
  {
    semanticId: "BR-LEADS-CONVERT-TO-MATTER-001",
    type: "BUSINESS_RULE",
    title: "A Lead can only be converted into a new Matter, never assigned to an existing one",
    statement:
      "Converting a lead creates a contact entry, a new matter entry, and a matter number. A lead can never be assigned to an already-existing matter — conversion always creates a new matter. Conversion can also be automated via a workflow's \"Convert to Matter\" action.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead"],
    source: LAWCUS_SUPPORT(
      "How to Add, Edit, Delete Leads, and Convert them into Matters in Lawcus.",
      "https://support.lawcus.com/en/articles/5010123-how-to-add-edit-delete-leads-and-convert-them-into-matters-in-lawcus",
    ),
  },
  {
    semanticId: "BR-LEADS-NOT-HIRED-VS-DELETE-001",
    type: "BUSINESS_RULE",
    title: "Mark a lead Not Hired to preserve it; deletion is permanent",
    statement:
      "Marking a lead as Not Hired requires selecting a Not Hired Reason, and preserves all of the lead's information for later reactivation via \"Re-open Lead\". Deleting a lead permanently removes all of its associated information and cannot be undone.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead"],
    source: LAWCUS_SUPPORT(
      "Manage Not Hired Leads and Customize Not Hired Reasons",
      "https://support.lawcus.com/en/articles/15880062-manage-not-hired-leads-and-customize-not-hired-reasons",
    ),
  },
  {
    semanticId: "EDGE-LEADS-DELETE-KEEPS-CONTACT-001",
    type: "EDGE_CASE",
    title: "Deleting a lead never deletes its contact; deleting a converted lead only deletes the matter",
    statement:
      "Deleting a lead does not automatically delete its linked contact or matter. If the lead was already converted into a matter and that lead is then deleted, only the matter is deleted — the associated contact remains intact.",
    doesNotMean:
      "Deleting a converted lead does not remove the client contact record it produced.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead", "contact"],
    source: LAWCUS_SUPPORT(
      "How to Add, Edit, Delete Leads, and Convert them into Matters in Lawcus.",
      "https://support.lawcus.com/en/articles/5010123-how-to-add-edit-delete-leads-and-convert-them-into-matters-in-lawcus",
    ),
  },
  {
    semanticId: "FIELD-LEADS-SOURCE-NOT-REQUIRED-001",
    type: "FIELD_RULE",
    title: "Lead Source is optional when creating a lead",
    statement:
      "Lawcus does not require the Lead Source field to be filled in when creating a new lead by default.",
    provenance: "DOCUMENTED",
    appliesTo: ["lead"],
    source: LAWCUS_SUPPORT(
      "How to Add, Edit, Delete Leads, and Convert them into Matters in Lawcus.",
      "https://support.lawcus.com/en/articles/5010123-how-to-add-edit-delete-leads-and-convert-them-into-matters-in-lawcus",
    ),
  },
];

export const CONTACT_CUSTOM_FIELDS_ITEMS = [
  {
    semanticId: "BR-CF-INDEPENDENT-OF-MATTER-001",
    type: "BUSINESS_RULE",
    title: "Contact custom fields and Matter custom fields are managed separately",
    statement:
      "Custom fields exist independently for Matters and for Contacts, each under its own tab in Firm Settings > Custom Fields (Matter Custom Fields / Contact Custom Fields).",
    provenance: "DOCUMENTED",
    appliesTo: ["contact", "matter"],
    // Real, live-verified in this project (Step 15): GET /v2/customfields
    // returns both CONTACT- and MATTER-scoped definitions in one list,
    // distinguished only by entity_type — exactly this rule.
    apiContracts: ["lawcus.customfields.list"],
    source: LAWCUS_SUPPORT(
      "How to Create a Custom Fields and Features Associated with it?",
      "https://support.lawcus.com/en/articles/6004984-how-to-create-a-custom-fields-and-features-associated-with-it",
    ),
  },
  {
    semanticId: "FIELD-CF-DEFINITION-SHAPE-001",
    type: "FIELD_RULE",
    title: "A custom field has a Name, a Field Type, and independent Default/Required flags",
    statement:
      "Each custom field definition has a Name, a Field Type (e.g. picklist, checkbox, date, number, text), a Default flag (the field always appears on the form when set), and a Required flag (the field is mandatory when set) — Default and Required are independent of each other.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact", "matter"],
    apiContracts: ["lawcus.customfields.list"],
    source: LAWCUS_SUPPORT(
      "How to Create a Custom Fields and Features Associated with it?",
      "https://support.lawcus.com/en/articles/6004984-how-to-create-a-custom-fields-and-features-associated-with-it",
    ),
  },
  {
    semanticId: "BR-CF-GROUP-PRACTICE-AREA-001",
    type: "BUSINESS_RULE",
    title: "A custom field group can be tied to a Practice Area and auto-applies there",
    statement:
      "Custom fields can be organized into named Custom Field Groups. A Matter Custom Field Group can optionally be bound to a specific Practice Area; when bound, that group's fields are automatically applied to every matter created in that practice area.",
    provenance: "DOCUMENTED",
    appliesTo: ["matter"],
    source: LAWCUS_SUPPORT("How to Create Custom Field Groups?", "https://support.lawcus.com/en/articles/5119758-how-to-create-custom-field-groups"),
  },
  {
    semanticId: "EDGE-CF-DELETE-PRESERVES-DATA-001",
    type: "EDGE_CASE",
    title: "Deleting a custom field definition does not remove already-recorded values",
    statement:
      "Deleting a custom field definition does not remove data already recorded on existing matters/contacts that used it, per the product's own FAQ (\"we don't remove already existing information on matters\").",
    doesNotMean:
      "Deleting a custom field does not retroactively clear its previously-saved values from existing records.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact", "matter"],
    expectedBehavior: {
      existing_contact: { field_value: "preserved" },
      existing_matter: { field_value: "preserved" },
    },
    source: LAWCUS_SUPPORT(
      "How to Create a Custom Fields and Features Associated with it?",
      "https://support.lawcus.com/en/articles/6004984-how-to-create-a-custom-fields-and-features-associated-with-it",
    ),
  },
  {
    semanticId: "INT-CF-IMPORT-CSV-001",
    type: "INTEGRATION_RULE",
    title: "Custom fields can be bulk-imported from a CSV file",
    statement:
      "Custom field definitions can be imported from a CSV file. The first import attempt shows the exact column headers the CSV must contain.",
    provenance: "DOCUMENTED",
    appliesTo: ["contact", "matter"],
    source: LAWCUS_SUPPORT(
      "How to Create a Custom Fields and Features Associated with it?",
      "https://support.lawcus.com/en/articles/6004984-how-to-create-a-custom-fields-and-features-associated-with-it",
    ),
  },
];

export const EDGES = [
  {
    type: "DEPENDS_ON",
    fromFeatureName: "Contacts",
    toFeatureName: "Contact Custom Fields",
    rationale:
      "The New/Edit Contact form includes a Custom Fields section for both Person and Company contacts.",
    source: LAWCUS_SUPPORT(
      "How to Add a New Contact, Edit and Delete a Contact in Lawcus?",
      "https://support.lawcus.com/en/articles/5010122-how-to-add-a-new-contact-edit-and-delete-a-contact-in-lawcus",
    ),
  },
  {
    type: "DEPENDS_ON",
    fromFeatureName: "Leads",
    toFeatureName: "Contact Custom Fields",
    rationale:
      "The New Lead form's Potential Client section includes a Custom Fields section, reusing Contact custom fields.",
    source: LAWCUS_SUPPORT(
      "How to Add, Edit, Delete Leads, and Convert them into Matters in Lawcus.",
      "https://support.lawcus.com/en/articles/5010123-how-to-add-edit-delete-leads-and-convert-them-into-matters-in-lawcus",
    ),
  },
  {
    type: "AFFECTS",
    fromFeatureName: "Leads",
    toFeatureName: "Contacts",
    rationale:
      "A Lead can be created from an existing Contact (\"Existing Contact\" option), and a lead's related contacts appear in the Contacts list even though the lead record itself does not.",
    source: LAWCUS_SUPPORT(
      "How to Add, Edit, Delete Leads, and Convert them into Matters in Lawcus.",
      "https://support.lawcus.com/en/articles/5010123-how-to-add-edit-delete-leads-and-convert-them-into-matters-in-lawcus",
    ),
  },
];

const FEATURES = {
  Authentication: {
    description: "Sign in, sign out, and session behavior for the Lawcus workspace.",
    items: AUTHENTICATION_ITEMS,
  },
  Contacts: {
    description: "People and companies stored in Lawcus — clients, potential clients, and other contacts.",
    items: CONTACTS_ITEMS,
  },
  Leads: {
    description: "Potential clients tracked through an intake pipeline until converted to a matter or marked not hired.",
    items: LEADS_ITEMS,
  },
  "Contact Custom Fields": {
    description: "Firm-defined additional fields collected on Contact (and Lead) records.",
    items: CONTACT_CUSTOM_FIELDS_ITEMS,
  },
};

/** Idempotently proposes every seed item and edge into the Knowledge Base
 * / Impact Graph via the given knowledge.mjs instance. Safe to call on
 * every server startup, same as testbook.mjs's syncCases(): proposeItem
 * and proposeEdge are both no-ops when nothing changed since the last
 * call. Never approves anything — every proposal lands as pending_review
 * for the operator to review in the Knowledge Inbox.
 *
 * Must run after testbook.syncCases() (server/index.mjs already orders it
 * this way) — any item above with relatedTests needs those TestBook rows
 * to exist first, since knowledge_item_tests.test_case_external_id is a
 * real FK. */
export function seedLawcusKnowledge(knowledge) {
  for (const [featureName, { description, items }] of Object.entries(FEATURES)) {
    for (const item of items) {
      knowledge.proposeItem({
        ...item,
        featureName,
        featureDescription: description,
      });
    }
  }
  for (const edge of EDGES) knowledge.proposeEdge(edge);
}
