import {
  runContactCustomFieldCheck,
  runContactCreationCheck,
  runContactMandatoryFieldValidationCheck,
  runContactAllFieldsCreationCheck,
  runContactPhoneValidationCheck,
  runContactBillingRateValidationCheck,
  runContactCompanyCreationCheck,
  runContactCompanyMandatoryFieldValidationCheck,
  runLeadCustomFieldCheck,
  runLeadCreationCheck,
  runLeadMandatoryFieldValidationCheck,
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
  "contacts.create_all_fields_verified_on_detail_page": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactAllFieldsCreationCheck",
      description:
        "Real browser-driven creation of a new Person Contact with every field across all four New Contact sections filled (Basic Details, Other Info, Addresses, Custom Fields), including linking a real existing Company/Referred By/Custom Contacts/Custom Matter record, an uploaded avatar image, and a Tag — not just First/Last Name. Adapts to this tenant's actual current custom field configuration (confirmed live to change over time) rather than a fixed list. Independently re-reads the resulting detail page's own text and confirms every value actually appears there. As of 2026-09-18: Basic Details/Other Info/Addresses/Company/Referred By/Custom Contacts/most Custom Fields/avatar are live-verified; the Tag picker's locator is known wrong (its real options are plain chips, not [role=\"option\"]) and Custom Matter/Custom Text were each fixed after a live failure but not yet re-verified against real staging — this case is NOT currently passing end to end. Do not treat it as trustworthy until a fresh run comes back status:\"passed\" with an empty missing array.",
    }),
    definition: {
      id: "contacts.create_all_fields_verified_on_detail_page",
      name: "Create a Person Contact with every field filled and verify the detail page",
      layer: "both",
      risk: "normal",
      status: "approved",
    },
  },
  "contacts.create_phone_number_validation": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactPhoneValidationCheck",
      description:
        "Real browser-driven check that a phone number with a \"555\" area code is rejected by Lawcus's own phone validation (\"Invalid phone number\") and blocks Contact creation. Directly observed against real staging before being written (2026-09-18).",
    }),
    definition: {
      id: "contacts.create_phone_number_validation",
      name: "Invalid phone number blocks Contact creation",
      layer: "ui",
      risk: "normal",
      status: "approved",
    },
  },
  "contacts.create_billing_rate_required_validation": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runContactBillingRateValidationCheck",
      description:
        "Real browser-driven check that enabling \"Enable client rates\" reveals a genuinely required \"Fixed rate\" field: Save is blocked while it's blank (same generic required-field message as First/Last Name), and filling it lets Save succeed with the rate shown correctly on the real detail page. A real, cascading-required field discovered live 2026-09-18.",
    }),
    definition: {
      id: "contacts.create_billing_rate_required_validation",
      name: "Enabling client rates requires a Fixed rate before Save",
      layer: "both",
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

// V5 "Keep going with Leads" (2026-09-16) — same action-x-type
// organization as Contacts. Real exploration (2026-09-16) confirmed the
// New Lead wizard's Step 1 ("Add potential client") offers the identical
// Person/Company choice as plain Contacts, PLUS a third "Existing
// Contact" option (link the lead to an already-existing contact instead
// of creating a new one) — not yet covered by any case here, a real gap
// noted for later, not fabricated coverage. Only the Person side is built
// out so far; Create Lead - Company and the "Existing Contact" case are
// still open (real staging login attempts started failing intermittently
// mid-exploration, 2026-09-16 — see the project memory note on staging
// throttling — so Company-type Step 1/Step 2 fields weren't yet
// confirmed live).
export const CREATE_LEAD_CASES = {
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
  "leads.create_mandatory_field_validation": {
    source: nativeSource({
      kind: "native",
      module: "server/core/live-runner.mjs",
      function: "runLeadMandatoryFieldValidationCheck",
      description:
        "Real browser-driven check that the New Lead wizard's Step 1 required fields (First Name, Last Name) show Lawcus's own inline validation and block advancing to Step 2 when left empty. Directly observed against real staging before being written (2026-09-16): both fields show \"This field is required and cannot be empty.\", Step 1 stays open, and no lead is created.",
    }),
    definition: {
      id: "leads.create_mandatory_field_validation",
      name: "Required-field validation blocks an empty Lead",
      layer: "ui",
      risk: "normal",
      status: "approved",
    },
  },
};

export const UPDATE_LEAD_CASES = {
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
};

export const LEADS_NATIVE_CASES = { ...CREATE_LEAD_CASES, ...UPDATE_LEAD_CASES };

// Suite -> the externalIds it contains, for callers (Step 18's MCP
// run_approved_suite tool) that need "everything in this suite" without
// re-deriving it from testbook.tree() every time.
export const NATIVE_SUITE_MEMBERS = {
  "Create Contact - Person": Object.keys(CREATE_CONTACT_CASES),
  "Create Contact - Company": Object.keys(CREATE_CONTACT_COMPANY_CASES),
  "Update Contact - Person": Object.keys(UPDATE_CONTACT_CASES),
  "Update Contact - Company": Object.keys(UPDATE_CONTACT_COMPANY_CASES),
  "Create Lead - Person": Object.keys(CREATE_LEAD_CASES),
  "Update Lead": Object.keys(UPDATE_LEAD_CASES),
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

// The QA-owned fixture records other checks depend on. resource-ownership
// refuses to ever record one of these as created by a run, so no cleanup
// (manual today, automated later) can be pointed at them.
export const PROTECTED_RESOURCE_IDS = [KNOWN_CONTACT_UUID, KNOWN_CONTACT_COMPANY_UUID, KNOWN_LEAD_UUID];

/** Builds a {passed, actual, screenshot, reason} outcome for an
 * update-and-restore custom-field check (Contacts and Leads share the
 * exact same four pass/fail conditions and diagnostic fields) — one
 * place for this so a plain "updateVerified:false" JSON blob never has
 * to stand in for a real explanation again (real gap hit live
 * 2026-09-23: a failed run gave no way to tell which of these four things
 * actually went wrong). */
function customFieldUpdateOutcome(r) {
  const passed = r.updateVerified && r.restored && r.updateCorrelation.contractMatch && r.restoreCorrelation.contractMatch;
  const reasons = [];
  if (!r.updateVerified) reasons.push(`After updating the field, it read "${r.afterUpdate}" instead of the new value that was set.`);
  if (!r.restored) reasons.push(`After restoring the field, it read "${r.afterRestore}" instead of its original value.`);
  if (!r.updateCorrelation.contractMatch) reasons.push(`The update request didn't match the approved contract${r.updateCorrelation.mismatchReason ? `: ${r.updateCorrelation.mismatchReason}` : "."}`);
  if (!r.restoreCorrelation.contractMatch) reasons.push(`The restore request didn't match the approved contract${r.restoreCorrelation.mismatchReason ? `: ${r.restoreCorrelation.mismatchReason}` : "."}`);
  return {
    passed,
    actual: JSON.stringify({ updateVerified: r.updateVerified, restored: r.restored }),
    screenshot: r.screenshot,
    reason: passed ? null : reasons.join(" "),
  };
}

/** Same idea as customFieldUpdateOutcome, for the simpler create-and-
 * verify-network-contract checks (Contacts and Leads share the same one
 * pass/fail condition here). A thrown error (e.g. no uuid found in the
 * post-save URL) still reaches executeImpactedTest as a thrown error, not
 * through this helper — its own screenshot travels on error.screenshot,
 * attached where it's thrown (contacts-browser.mjs / leads-browser.mjs). */
function createOutcome(r, recordKind) {
  const passed = r.correlation.contractMatch && r.correlation.cardinalityOk;
  return {
    passed,
    actual: JSON.stringify({ uuid: r.uuid, contractMatch: r.correlation.contractMatch }),
    screenshot: r.screenshot,
    reason: passed ? null : `The ${recordKind} was created, but its network request didn't match the approved create contract${r.correlation.mismatchReason ? `: ${r.correlation.mismatchReason}` : "."}`,
  };
}

// Save was clicked but the post-save URL never confirmed a record: the
// server may or may not have created it. Recorded as a "may exist" leftover
// (never as proof) so a partial creation is visible instead of vanishing.
const UNCONFIRMED_CREATE = /Could not determine the created (contact|lead)'s uuid/;

/** Records what a check creates. Everything is recorded with cleanup policy
 * "manual": deleting records from a shared staging tenant has not been
 * authorized, so they are reported to a person, never deleted by the tool.
 * With no resourceOwnership (a minimal context) recording is a no-op. */
function ownershipTracker({ resourceOwnership, runId }) {
  const record = (fields) =>
    resourceOwnership?.recordCreated({ runId, environmentId: "lawcus", cleanupPolicy: "manual", ...fields });
  return {
    created(resourceType, resourceId, createdByPrimitive, displayName) {
      if (resourceId) record({ resourceType, resourceId, createdByPrimitive, displayName });
    },
    async track(kind, createdByPrimitive, displayName, run) {
      try {
        return await run();
      } catch (error) {
        if (UNCONFIRMED_CREATE.test(String(error?.message))) {
          try {
            record({
              resourceType: `${kind}_unconfirmed`,
              resourceId: `unconfirmed:${runId}:${createdByPrimitive}`,
              createdByPrimitive,
              displayName: `MAY EXIST — search Lawcus for "${displayName}"`,
            });
          } catch (recordError) {
            error.message += ` (Also failed to record a possible leftover record: ${recordError.message})`;
          }
        }
        throw error;
      }
    },
  };
}

/**
 * The single, shared wiring from a native case's external_id to the real
 * function that executes it — used by both the HTTP /impacted-tests/run
 * route and Step 18's MCP run_approved_test/run_approved_suite tools, so
 * there is exactly one place this mapping is defined, never two copies
 * that could drift apart.
 *
 * `impl` overrides the live check functions (tests only — the defaults are
 * the real browser-driven checks).
 */
export function buildNativeRunners({ apiContracts, mutationJournal, runId, resourceOwnership = null, impl = {} }) {
  const ts = Date.now();
  const fn = {
    runContactCustomFieldCheck,
    runContactCreationCheck,
    runContactMandatoryFieldValidationCheck,
    runContactAllFieldsCreationCheck,
    runContactPhoneValidationCheck,
    runContactBillingRateValidationCheck,
    runContactCompanyCreationCheck,
    runContactCompanyMandatoryFieldValidationCheck,
    runLeadCustomFieldCheck,
    runLeadCreationCheck,
    runLeadMandatoryFieldValidationCheck,
    ...impl,
  };
  const own = ownershipTracker({ resourceOwnership, runId });
  return {
    "contacts.custom_field_update_existing": async () => {
      const r = await fn.runContactCustomFieldCheck({ apiContracts, mutationJournal, runId, uuid: KNOWN_CONTACT_UUID, fieldName: "Custom Text", newValue: `QA impacted-test ${ts}` });
      return customFieldUpdateOutcome(r);
    },
    "contacts.create_new_verifies_custom_fields": async () => {
      const name = `QA Agent ${ts}`;
      const r = await own.track("contact", "contacts.create_new_verifies_custom_fields", name, () =>
        fn.runContactCreationCheck({ apiContracts, firstName: "QA Agent", lastName: String(ts) }));
      own.created("contact", r.uuid, "contacts.create_new_verifies_custom_fields", name);
      return createOutcome(r, "contact");
    },
    "contacts.create_mandatory_field_validation": async () => {
      const r = await fn.runContactMandatoryFieldValidationCheck();
      return { passed: r.messageCount === 2 && r.noContactCreated, actual: JSON.stringify(r) };
    },
    "contacts.create_all_fields_verified_on_detail_page": async () => {
      const marker = `QAFieldTest${ts}`;
      const r = await own.track("contact", "contacts.create_all_fields_verified_on_detail_page", marker, () =>
        fn.runContactAllFieldsCreationCheck({ apiContracts, marker }));
      own.created("contact", r.uuid, "contacts.create_all_fields_verified_on_detail_page", `${marker} Contact`);
      return {
        passed: r.correlation.contractMatch && r.correlation.cardinalityOk && r.missing.length === 0,
        actual: JSON.stringify({ uuid: r.uuid, contractMatch: r.correlation.contractMatch, missing: r.missing, picked: r.picked }),
      };
    },
    "contacts.create_phone_number_validation": async () => {
      const r = await fn.runContactPhoneValidationCheck();
      return { passed: r.invalidMessageShown && r.noContactCreated, actual: JSON.stringify(r) };
    },
    "contacts.create_billing_rate_required_validation": async () => {
      const r = await fn.runContactBillingRateValidationCheck();
      // This check saves a real contact on purpose (the "fill Fixed rate and
      // succeed" half) — and if the blocked half wrongly created one, that
      // one is a leftover too.
      own.created("contact", r.uuid, "contacts.create_billing_rate_required_validation", "QA Validation Test");
      own.created("contact", r.blockedCreatedUuid, "contacts.create_billing_rate_required_validation", "QA Validation Test (created when it should have been blocked)");
      return {
        passed: r.blockedMessageCount >= 1 && r.noContactCreatedWhenBlank && r.createdAfterFilling && r.rateShownCorrectly,
        actual: JSON.stringify(r),
      };
    },
    "contacts.create_new_company_verifies_custom_fields": async () => {
      const name = `QA Agent - ${ts}`;
      const r = await own.track("contact", "contacts.create_new_company_verifies_custom_fields", name, () =>
        fn.runContactCompanyCreationCheck({ apiContracts, name }));
      own.created("contact", r.uuid, "contacts.create_new_company_verifies_custom_fields", `${name} (Company)`);
      return { passed: r.correlation.contractMatch && r.correlation.cardinalityOk, actual: JSON.stringify({ uuid: r.uuid, contractMatch: r.correlation.contractMatch }) };
    },
    "contacts.create_company_mandatory_field_validation": async () => {
      const r = await fn.runContactCompanyMandatoryFieldValidationCheck();
      return { passed: r.messageCount === 1 && r.noContactCreated, actual: JSON.stringify(r) };
    },
    "contacts.custom_field_update_existing_company": async () => {
      const r = await fn.runContactCustomFieldCheck({ apiContracts, mutationJournal, runId, uuid: KNOWN_CONTACT_COMPANY_UUID, fieldName: "Custom Text", newValue: `QA impacted-test ${ts}` });
      return customFieldUpdateOutcome(r);
    },
    "leads.custom_field_update_existing": async () => {
      const r = await fn.runLeadCustomFieldCheck({ apiContracts, mutationJournal, runId, uuid: KNOWN_LEAD_UUID, fieldName: "Custom Text", newValue: `QA impacted-test ${ts}` });
      return customFieldUpdateOutcome(r);
    },
    "leads.create_new_verifies_custom_fields": async () => {
      const name = `QA Agent ${ts + 1}`;
      const matterName = `QA Agent - ${ts + 1}`;
      const r = await own.track("lead", "leads.create_new_verifies_custom_fields", name, () =>
        fn.runLeadCreationCheck({ apiContracts, firstName: "QA Agent", lastName: String(ts + 1), matterName }));
      // Creating a lead also creates its potential-client contact and matter.
      // Only the lead's own id is captured; those linked records are not.
      own.created("lead", r.uuid, "leads.create_new_verifies_custom_fields", `${name} — matter "${matterName}" (its linked contact/matter records are not tracked)`);
      return createOutcome(r, "lead");
    },
    "leads.create_mandatory_field_validation": async () => {
      const r = await fn.runLeadMandatoryFieldValidationCheck();
      return { passed: r.messageCount === 2 && r.stayedOnStep1 && r.noLeadCreated, actual: JSON.stringify(r) };
    },
  };
}

/** Idempotently syncs both native case sets into the TestBook. Safe to
 * call on every server startup, same as every other seed function in this
 * project — testbook.syncCases() is already a no-op when nothing changed. */
/**
 * Cases whose automation is known to be broken, keyed by external_id.
 * Code is the authority (like a case's own status): quarantining or
 * releasing a case is a reviewed change to this map, applied on every
 * startup by seedLawcusNativeCases. A quarantined case keeps its
 * definition, versions and history; it is simply never run or counted as
 * coverage until it is removed from here after a fresh staging pass.
 */
export const NATIVE_QUARANTINE = {
  "contacts.create_all_fields_verified_on_detail_page":
    "Last real staging run failed (2026-09-18): the Tag picker locator targets [role=\"option\"] but the tenant's tag chips are plain elements, and the Custom Text / Custom Matter fixes were never re-verified on staging. Release only after a fresh staging run passes with an empty `missing` list.",
};

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
    suiteName: "Create Lead - Person",
    suiteDescription: "Real, browser-driven checks of the New Lead wizard's Step 1, Person type — creation and its own field validation.",
    priority: "normal",
    entries: CREATE_LEAD_CASES,
  });
  testbook.syncCases({
    featureName: "Leads",
    featureDescription: "Potential clients tracked through an intake pipeline until converted to a matter or marked not hired.",
    suiteName: "Update Lead",
    suiteDescription: "Real, browser-driven checks of editing an existing Lead's matter-level custom fields.",
    priority: "normal",
    entries: UPDATE_LEAD_CASES,
  });
  for (const externalId of Object.values(NATIVE_SUITE_MEMBERS).flat()) {
    const reason = NATIVE_QUARANTINE[externalId];
    testbook.setAutomationReadiness(externalId, reason ? "quarantined" : "ready", reason ?? null);
  }
}
