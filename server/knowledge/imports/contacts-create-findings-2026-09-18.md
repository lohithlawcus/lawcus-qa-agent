## Feature: Contacts
Description: People and companies stored in Lawcus — clients, potential clients, and other contacts.

### VALIDATION_RULE: VAL-CONTACTS-PHONE-555-001
Title: A phone number with a 555 area code is rejected
Provenance: OBSERVED
Statement: In the New Contact dialog, a phone number whose area code is 555 is rejected with an "Invalid phone number" error and Save stays blocked until it is corrected.
Does Not Mean: This has not been confirmed as intentional product behavior, and the validation rule for other area codes is unknown.
Applies To: new_contact
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18
Related Tests: contacts.create_phone_number_validation

### FIELD_RULE: FIELD-CONTACTS-PERSON-NAME-FIELDS-001
Title: A Person contact needs a First Name and a Last Name
Provenance: OBSERVED
Statement: For a Person contact, First Name and Last Name are both mandatory, while Prefix, Middle Name, Gender, Date of Birth, Email, Phone, Title, Website, Lead Source, LEDES Client ID, Note and Addresses are optional.
Does Not Mean: A Company contact does not use these fields; it has a single mandatory Name instead.
Applies To: new_contact
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18
Related Tests: contacts.create_mandatory_field_validation

### VALIDATION_RULE: VAL-CONTACTS-CLIENT-RATE-FIXED-RATE-001
Title: Enabling client rates makes Fixed rate mandatory
Provenance: OBSERVED
Statement: Turning on "Enable client rates" in Billing Preference reveals a Rate Options choice that defaults to "Fixed Rate for All Timekeepers" and a "Fixed rate" amount that is mandatory, and Save is blocked while it is blank.
Does Not Mean: The "Individual Timekeeper Rates" option was not explored, so what it requires is unknown.
Applies To: new_contact
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18
Related Tests: contacts.create_billing_rate_required_validation

### FIELD_RULE: FIELD-CONTACTS-DOB-FORMAT-001
Title: Date of Birth uses DD/MM/YYYY
Provenance: OBSERVED
Statement: The Date of Birth field in the New Contact dialog takes a date typed as DD/MM/YYYY (for example 15/06/1990) and the detail page shows it in that same format.
Applies To: new_contact
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18
Related Tests: contacts.create_all_fields_verified_on_detail_page

### TEST_DATA_RULE: DATA-CONTACTS-GENDER-OPTIONS-001
Title: Gender offers four fixed options
Provenance: OBSERVED
Statement: The Gender dropdown on a Person contact offers exactly Male, Female, Non-binary and Other.
Applies To: new_contact
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18

### FIELD_RULE: FIELD-CONTACTS-DISPLAY-NAME-001
Title: The header name is composed from the name parts
Provenance: OBSERVED
Statement: The contact detail page header shows the name composed as Prefix, First Name, Middle Name, Last Name, and these parts do not appear as separately labelled fields on the Info tab.
Applies To: existing_contact
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18

### ENVIRONMENT_RULE: ENV-CONTACTS-CUSTOM-FIELDS-MUTABLE-001
Title: The tenant's custom fields change over time
Provenance: OBSERVED
Statement: Custom field definitions on the Fiveriverz staging tenant are edited over time — at least five new Contact custom fields (Custom Date, Custom Multi Text, Custom Matter, Custom Org Users, Custom Checkbox) appeared and Custom Text went from hidden to shown by default within one working session — so tests must detect fields at run time instead of assuming a fixed list.
Does Not Mean: Who changes these definitions, and how often, has not been confirmed.
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18
Related Tests: contacts.create_all_fields_verified_on_detail_page

### UI_ACTION: UI-CONTACTS-CUSTOM-FIELD-INPUT-ID-001
Title: Custom field inputs have a stable DOM id
Provenance: OBSERVED
Statement: Each custom field input in the New Contact dialog has a DOM id of the form custom-component-<Field Name> (for example custom-component-Custom Text), which is a more reliable automation anchor than label text or position.
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18

### UI_ACTION: UI-CONTACTS-DIALOG-SCOPE-001
Title: Scope locators to the New Contact dialog
Provenance: OBSERVED
Statement: The Contacts list page stays rendered behind the New Contact dialog and repeats some of its text (a "Prefix" column header and a "Company" filter tab), so every locator must be scoped to [role="dialog"] or it can match the wrong element.
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18

### UI_ACTION: UI-CONTACTS-SEARCH-FIELD-ANCHOR-001
Title: Find the search-link fields by placeholder position
Provenance: OBSERVED
Statement: Inside the dialog the exact text "Company" also matches the Contact Type radio button, so the Company, Referred By, Custom Contacts and Custom Matter fields are best located by their "Type to search..." placeholder, whose DOM order was Company, Referred By, Custom Contacts, Custom Matter.
Does Not Mean: The positions of the two custom fields can shift when the tenant's custom fields change, so re-check the order before relying on them.
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18

### UI_ACTION: UI-CONTACTS-TAG-PICKER-001
Title: The tag picker's options are plain chips
Provenance: OBSERVED
Statement: The tag icon button (aria-label "Manage Tags Button") opens a popover with a "Search or Create new" box and the existing tags shown as plain coloured chips rather than role="option" elements, and opening it sends no network request because the list is already loaded.
Source Title: Live exploration of the New Contact dialog on Fiveriverz, 2026-09-18
Related Tests: contacts.create_all_fields_verified_on_detail_page

### API_CONTRACT: API-CONTACTS-SEARCH-CONTACTS-001
Title: The Company search field calls POST /search/contacts
Provenance: OBSERVED
Statement: The Company field queries POST /search/contacts with a {params:{terms,type},pagination:{skip,take}} body, once on focus without terms and again as the user types, and it sends type "Company".
Does Not Mean: Referred By and Custom Contacts started returning results once this endpoint was allowed, so they very likely use it too, but their request bodies were not captured.
Source Title: Live network capture of the New Contact dialog on Fiveriverz, 2026-09-18

### API_CONTRACT: API-CONTACTS-SEARCH-MATTERS-001
Title: The Custom Matter search field calls POST /search/matters
Provenance: OBSERVED
Statement: The Custom Matter field queries POST /search/matters with a {params:{status,terms},logicOperator,pagination} body that filters matters to status OPEN or LEAD.
Does Not Mean: This was read from the request filter only; it was not confirmed that closed matters are absent from the results.
Source Title: Live network capture of the New Contact dialog on Fiveriverz, 2026-09-18

### API_CONTRACT: API-CONTACTS-LIST-001
Title: The Contacts list loads rows with POST /v2/contacts
Provenance: OBSERVED
Statement: The Contacts list page loads its rows with POST /v2/contacts and a {filters,pagination,multi_sorting} body, which is a read even though it uses POST, and it fires before the New Contact dialog is opened.
Does Not Mean: This is not the endpoint behind the dialog's search fields.
Source Title: Live network capture of the Contacts list on Fiveriverz, 2026-09-18

### ENVIRONMENT_RULE: ENV-CONTACTS-RUNNER-BLOCKS-UNLISTED-POST-001
Title: The QA runner silently blocks unlisted POST requests
Provenance: OBSERVED
Statement: The QA runner's Contacts and Leads network policies abort any POST request that is not explicitly allowlisted, so a page control that returns nothing while the same action works in an unrestricted browser most likely means a blocked request rather than a timing problem.
Does Not Mean: Allowlisting a guessed endpoint fixes nothing; the real request must be captured first, as the wrong /v2/contacts guess showed.
Source Title: Live diagnosis of the Create Contact check, 2026-09-18

## Feature: Authentication
Description: Sign in, sign out, and session behavior for the Lawcus workspace.

### ENVIRONMENT_RULE: ENV-AUTH-STAGING-LOGIN-STALL-001
Title: Login can stall after a burst of automated logins
Provenance: OBSERVED
Statement: After a burst of roughly eight to ten automated logins in about 25 minutes, three consecutive login attempts on Fiveriverz staging left the form unchanged on /login with no error or spinner for over 15 seconds, so repeated retries should back off instead of hammering the login.
Does Not Mean: The cause was not confirmed; rate limiting or a session conflict is suspected but unproven.
Source Title: Live diagnosis of the Create Contact check, 2026-09-18
