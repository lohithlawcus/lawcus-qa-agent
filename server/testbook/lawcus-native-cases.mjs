import {
  runContactCustomFieldCheck,
  runContactCreationCheck,
  runContactMandatoryFieldValidationCheck,
  runContactCompanyCreationCheck,
  runContactCompanyMandatoryFieldValidationCheck,
  runLeadCustomFieldCheck,
  runLeadCreationCheck,
} from "../core/live-runner.mjs";

// V5 Step 16 — registers Step 15's already-built, already-live-verified
// Contact/Lead primitives as real TestBook coverage, so Step 16's gap
// detection has genuine cases to check against instead of finding every
// Contact/Lead scenario "uncovered" despite this project already having
// real, working code for them.
//
// These cases are NOT DSL-defined (server/core/dsl.mjs's primitive-sequence
// executor only knows the 10 login primitives) — they're native JS
// functions in live-runner.mjs, a deliberate difference from
// login-essentials' cases, not an oversight (see contacts-browser.mjs's
// and leads-browser.mjs's own file comments for why: the "option 2,
// browser-driven for writes" decision). testbook.syncCases()'s "source"
// column is reused honestly here: instead of DSL YAML text, each entry's
// source is a small, factually accurate JSON descriptor of what actually
// implements the case — real module/function names that exist in this
// codebase right now, not invented ones. Hashing/versioning that
// descriptor still means what it always means: the case changes version
// only when what backs it genuinely changes.

const nativeSource = (obj) => JSON.stringify(obj, null, 2);

// V5 "Start with Contacts" (2026-09-16) — the Contacts feature is now
// organized into the suites the user actually asked for: one sub-suite
// per action x contact-type combination (Create Contact - Person, Create
// Contact - Company, Update Contact - Person, Update Contact - Company),
// not one flat "contact-verification" bucket. This same action-x-type
// pattern is meant to repeat for every other feature (Matters, Invoices,
// Leads, ...) as their own suites get built out — not special-cased to
// Contacts. Each case group below is its own object so
// seedLawcusNativeCases can sync it under its own suite name;
// CONTACTS_NATIVE_CASES stays the merged view existing callers
// (buildNativeRunners, the native-cases tests) already rely on.
export const CREATE_CONTACT_CASES = {
  "contacts.create_new_verifies_custom_fields": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactCreationCheck",
      description:
        "Real browser-driven creation of a brand-new standalone Contact through the real \"New Contact\" UI, correlated against the approved lawcus.contacts.create contract — proves the custom fields section renders and defaults correctly for a genuinely new record. Live-verified in Step 15 (commit 7507767).",
    }),
    definition: {
      id: "contacts.create_new_verifies_custom_fields",
      name: "Create a new Contact and verify its custom fields section",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
  "contacts.create_mandatory_field_validation": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactMandatoryFieldValidationCheck",
      description:
        "Real browser-driven check that the New Contact form's required fields (First Name, Last Name) show Lawcus's own inline validation and block creation when left empty. Directly observed against real staging before being written (2026-09-16): both fields show \"This field is required and cannot be empty.\" and no contact is created.",
    }),
    definition: {
      id: "contacts.create_mandatory_field_validation",
      name: "Required-field validation blocks an empty Contact",
      layer: "ui",
      risk: "normal",
      status: "approved",
    },
  },
};

export const CREATE_CONTACT_COMPANY_CASES = {
  "contacts.create_new_company_verifies_custom_fields": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactCompanyCreationCheck",
      description:
        "Real browser-driven creation of a brand-new Company Contact through the real \"New Contact\" UI, Company type, correlated against the approved lawcus.contacts.create contract. Live-verified 2026-09-16.",
    }),
    definition: {
      id: "contacts.create_new_company_verifies_custom_fields",
      name: "Create a new Company Contact and verify its custom fields section",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
  "contacts.create_company_mandatory_field_validation": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactCompanyMandatoryFieldValidationCheck",
      description:
        "Real browser-driven check that the New Contact form's Company-type required field (Name) shows Lawcus's own inline validation and blocks creation when left empty. Directly observed against real staging before being written (2026-09-16): the Name field shows \"This field is required and cannot be empty.\" and no contact is created — exactly one message, since Company has no First/Last split.",
    }),
    definition: {
      id: "contacts.create_company_mandatory_field_validation",
      name: "Required-field validation blocks an empty Company Contact",
      layer: "ui",
      risk: "normal",
      status: "approved",
    },
  },
};

export const UPDATE_CONTACT_CASES = {
  "contacts.custom_field_update_existing": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactCustomFieldCheck",
      description:
        "Real browser-driven update-and-restore of an existing Contact's custom field value, correlated against the approved lawcus.contacts.update contract. Live-verified in Step 15 (commit 67596d4).",
    }),
    definition: {
      id: "contacts.custom_field_update_existing",
      name: "Update an existing Contact's custom field and restore it",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
};

export const UPDATE_CONTACT_COMPANY_CASES = {
  "contacts.custom_field_update_existing_company": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactCustomFieldCheck",
      description:
        "Real browser-driven update-and-restore of an existing Company Contact's custom field value, correlated against the approved lawcus.contacts.update contract. Reuses the same function as the Person suite's equivalent case — the Edit Contact > Custom Fields panel is the same real UI for both contact types — pointed at a known Company contact instead. Live-verified 2026-09-16.",
    }),
    definition: {
      id: "contacts.custom_field_update_existing_company",
      name: "Update an existing Company Contact's custom field and restore it",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
};

export const CONTACTS_NATIVE_CASES = { ...CREATE_CONTACT_CASES, ...CREATE_CONTACT_COMPANY_CASES, ...UPDATE_CONTACT_CASES, ...UPDATE_CONTACT_COMPANY_CASES };

export const LEADS_NATIVE_CASES = {
  "leads.custom_field_update_existing": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runLeadCustomFieldCheck",
      description:
        "Real browser-driven update-and-restore of an existing Lead's matter-level custom field value, correlated against the approved lawcus.leads.update contract. Live-verified in Step 15 (commit 95d3a47).",
    }),
    definition: {
      id: "leads.custom_field_update_existing",
      name: "Update an existing Lead's custom field and restore it",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
  "leads.create_new_verifies_custom_fields": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runLeadCreationCheck",
      description:
        "Real browser-driven creation of a brand-new Lead (Potential Client + Matter) through the real \"New Lead\" two-step wizard, correlated against the approved lawcus.leads.create contract. Live-verified in Step 15 (commit 7507767).",
    }),
    definition: {
      id: "leads.create_new_verifies_custom_fields",
      name: "Create a new Lead and verify its custom fields section",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
};

// Suite -> the externalIds it contains, for callers (Step 18's MCP
// run_approved_suite tool) that need "everything in this suite" without
// re-deriving it from testbook.tree() every time.
export const NATIVE_SUITE_MEMBERS = {
  "Create Contact - Person": Object.keys(CREATE_CONTACT_CASES),
  "Create Contact - Company": Object.keys(CREATE_CONTACT_COMPANY_CASES),
  "Update Contact - Person": Object.keys(UPDATE_CONTACT_CASES),
  "Update Contact - Company": Object.keys(UPDATE_CONTACT_COMPANY_CASES),
  "lead-verification": Object.keys(LEADS_NATIVE_CASES),
};

// Real, owned staging fixtures from Step 15's own live-verified work (see
// the project memory note on those commits) — not invented here, and
// never used for any case this project doesn't already know how to run.
const KNOWN_CONTACT_UUID = "e2bf71a0-ae87-11f1-ab8e-f18331cbd381"; // "QA Batch Test"
// Created 2026-09-16 by the very first live run of
// contacts.create_new_company_verifies_custom_fields (Create Contact -
// Company suite) — a real Company contact, not invented for this purpose.
const KNOWN_CONTACT_COMPANY_UUID = "9f1c75c0-b1d0-11f1-8594-1376676d24eb"; // "QA Agent - <timestamp>" (Company)
const KNOWN_LEAD_UUID = "c59e9ec0-b115-11f1-b4fe-1feb32eda16d"; // "QA Agent - 1789484203935"

/**
 * The single, shared wiring from a native case's external_id to the real
 * function that executes it — used by both the HTTP /impacted-tests/run
 * route and Step 18's MCP run_approved_test/run_approved_suite tools, so
 * there is exactly one place this mapping is defined, never two copies
 * that could drift apart.
 */
export function buildNativeRunners({ apiContracts, mutationJournal, runId }) {
  const ts = Date.now();
  return {
    "contacts.custom_field_update_existing": async () => {
      const r = await runContactCustomFieldCheck({ apiContracts, mutationJournal, runId, uuid: KNOWN_CONTACT_UUID, fieldName: "Custom Text", newValue: `QA impacted-test ${ts}` });
      return { passed: r.updateVerified && r.restored && r.updateCorrelation.contractMatch && r.restoreCorrelation.contractMatch, actual: JSON.stringify({ updateVerified: r.updateVerified, restored: r.restored }) };
    },
    "contacts.create_new_verifies_custom_fields": async () => {
      const r = await runContactCreationCheck({ apiContracts, firstName: "QA Agent", lastName: String(ts) });
      return { passed: r.correlation.contractMatch && r.correlation.cardinalityOk, actual: JSON.stringify({ uuid: r.uuid, contractMatch: r.correlation.contractMatch }) };
    },
    "contacts.create_mandatory_field_validation": async () => {
      const r = await runContactMandatoryFieldValidationCheck();
      return { passed: r.messageCount === 2 && r.noContactCreated, actual: JSON.stringify(r) };
    },
    "contacts.create_new_company_verifies_custom_fields": async () => {
      const r = await runContactCompanyCreationCheck({ apiContracts, name: `QA Agent - ${ts}` });
      return { passed: r.correlation.contractMatch && r.correlation.cardinalityOk, actual: JSON.stringify({ uuid: r.uuid, contractMatch: r.correlation.contractMatch }) };
    },
    "contacts.create_company_mandatory_field_validation": async () => {
      const r = await runContactCompanyMandatoryFieldValidationCheck();
      return { passed: r.messageCount === 1 && r.noContactCreated, actual: JSON.stringify(r) };
    },
    "contacts.custom_field_update_existing_company": async () => {
      const r = await runContactCustomFieldCheck({ apiContracts, mutationJournal, runId, uuid: KNOWN_CONTACT_COMPANY_UUID, fieldName: "Custom Text", newValue: `QA impacted-test ${ts}` });
      return { passed: r.updateVerified && r.restored && r.updateCorrelation.contractMatch && r.restoreCorrelation.contractMatch, actual: JSON.stringify({ updateVerified: r.updateVerified, restored: r.restored }) };
    },
    "leads.custom_field_update_existing": async () => {
      const r = await runLeadCustomFieldCheck({ apiContracts, mutationJournal, runId, uuid: KNOWN_LEAD_UUID, fieldName: "Custom Text", newValue: `QA impacted-test ${ts}` });
      return { passed: r.updateVerified && r.restored && r.updateCorrelation.contractMatch && r.restoreCorrelation.contractMatch, actual: JSON.stringify({ updateVerified: r.updateVerified, restored: r.restored }) };
    },
    "leads.create_new_verifies_custom_fields": async () => {
      const r = await runLeadCreationCheck({ apiContracts, firstName: "QA Agent", lastName: String(ts + 1), matterName: `QA Agent - ${ts + 1}` });
      return { passed: r.correlation.contractMatch && r.correlation.cardinalityOk, actual: JSON.stringify({ uuid: r.uuid, contractMatch: r.correlation.contractMatch }) };
    },
  };
}

/** Idempotently syncs both native case sets into the TestBook. Safe to
 * call on every server startup, same as every other seed function in this
 * project — testbook.syncCases() is already a no-op when nothing changed. */
export function seedLawcusNativeCases(testbook) {
  testbook.syncCases({
    featureName: "Contacts",
    featureDescription: "People and companies stored in Lawcus — clients, potential clients, and other contacts.",
    suiteName: "Create Contact - Person",
    suiteDescription: "Real, browser-driven checks of the New Contact form, Person type — creation and its own field validation.",
    priority: "normal",
    entries: CREATE_CONTACT_CASES,
  });
  testbook.syncCases({
    featureName: "Contacts",
    featureDescription: "People and companies stored in Lawcus — clients, potential clients, and other contacts.",
    suiteName: "Create Contact - Company",
    suiteDescription: "Real, browser-driven checks of the New Contact form, Company type — creation and its own field validation.",
    priority: "normal",
    entries: CREATE_CONTACT_COMPANY_CASES,
  });
  testbook.syncCases({
    featureName: "Contacts",
    featureDescription: "People and companies stored in Lawcus — clients, potential clients, and other contacts.",
    suiteName: "Update Contact - Person",
    suiteDescription: "Real, browser-driven checks of editing an existing Person Contact.",
    priority: "normal",
    entries: UPDATE_CONTACT_CASES,
  });
  testbook.syncCases({
    featureName: "Contacts",
    featureDescription: "People and companies stored in Lawcus — clients, potential clients, and other contacts.",
    suiteName: "Update Contact - Company",
    suiteDescription: "Real, browser-driven checks of editing an existing Company Contact.",
    priority: "normal",
    entries: UPDATE_CONTACT_COMPANY_CASES,
  });
  testbook.syncCases({
    featureName: "Leads",
    featureDescription: "Potential clients tracked through an intake pipeline until converted to a matter or marked not hired.",
    suiteName: "lead-verification",
    suiteDescription: "Real, browser-driven Lead checks (custom field update/restore, new-Lead creation) built in Step 15.",
    priority: "normal",
    entries: LEADS_NATIVE_CASES,
  });
}
