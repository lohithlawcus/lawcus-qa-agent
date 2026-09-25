// What each native check does about the data it needs, kept as plain data so a
// planner can decide whether a prerequisite is covered without importing any
// browser code.
//
//   selfProvisions  the check creates this itself, through the real UI, and
//                   records what it made as owned. (Testing the feature must be
//                   done this way: it is the thing under test or its direct setup.)
//   usesFixtures    the check relies on something that already exists in the
//                   tenant (a protected fixture record, or configuration such as
//                   the tenant's Contact custom fields). Read/restore only.
//
//   needsNoSetup   the check does not depend on any prerequisite data at all
//                  (for example: it submits an empty form and expects validation).
//
// A prerequisite that a case neither provisions nor declares as a fixture is
// UNMET, and a plan that needs it is blocked rather than guessed.
export const CASE_SETUP = {
  "matters.create_for_new_contact": { selfProvisions: ["Contacts"] },
  "matters.create_mandatory_field_validation": { needsNoSetup: true },
  "contacts.custom_field_update_existing": { usesFixtures: ["Contact Custom Fields"] },
  "contacts.custom_field_update_existing_company": { usesFixtures: ["Contact Custom Fields"] },
  "contacts.create_new_verifies_custom_fields": { usesFixtures: ["Contact Custom Fields"] },
  "leads.custom_field_update_existing": { usesFixtures: ["Contact Custom Fields"] },
  "leads.create_new_verifies_custom_fields": { usesFixtures: ["Contact Custom Fields"] },
};
