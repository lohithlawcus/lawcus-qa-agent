## Feature: Matters
Description: Legal matters (cases) in Lawcus, each linked to a client Contact.

### FIELD_RULE: FIELD-MATTERS-CREATE-REQUIRED-FIELDS-001
Title: A new Matter needs a Client, a Matter Name, a Pipeline and a Stage
Provenance: OBSERVED
Statement: In the New Matter dialog, Client and Matter Name are mandatory and start empty; Pipeline and Stage are also mandatory but arrive pre-filled ("Default" / "Case Assessment"). Open Date defaults to today; Close Date, Statute of Limitations, Practice Area, Location and the rest are optional.
Does Not Mean: Other pipelines, or a tenant with different defaults, may pre-fill different values.
Applies To: new_matter
Source Title: Live exploration of the New Matter dialog on Fiveriverz, 2026-09-26
Related Tests: matters.create_mandatory_field_validation

### VALIDATION_RULE: VAL-MATTERS-EMPTY-CREATE-BLOCKED-001
Title: Submitting an empty New Matter form is blocked
Provenance: OBSERVED
Statement: Clicking Create on an empty New Matter dialog shows "This field is required and cannot be empty." under Client and under Matter Name, sends no create request, and leaves the dialog open.
Does Not Mean: Other validation rules (dates, rates, custom fields) were not explored.
Applies To: new_matter
Source Title: Live exploration of the New Matter dialog on Fiveriverz, 2026-09-26
Related Tests: matters.create_mandatory_field_validation

### WORKFLOW_RULE: WF-MATTERS-CLIENT-PICKER-001
Title: The Client is chosen by searching existing contacts
Provenance: OBSERVED
Statement: The Client field is a "Type to search..." picker backed by POST /search/contacts. Its dropdown always ends with an Add "<typed text>" row that opens an "Add a Contact" dialog instead of selecting an existing contact.
Does Not Mean: Selecting the Add row is not a way to pick an existing client; it starts creating a new contact.
Applies To: new_matter
Source Title: Live exploration of the New Matter dialog on Fiveriverz, 2026-09-26

### BUSINESS_RULE: BR-MATTERS-CREATE-LINKS-CLIENT-001
Title: A Matter created for a contact lists that contact as its client
Provenance: OBSERVED
Statement: After a Matter is created with a contact chosen as Client, GET /matters/<uuid> returns that contact in its contacts with client_id set, and the Matter's detail page shows "Client Name" with the contact's full name once it has loaded. The page first shows a placeholder dash for the client, so it must be read after loading finishes.
Does Not Mean: The Contact's own detail page does not list the Matter: it has no Matters tab (tabs seen: Info, Calendar, Interactions, Invoices, Transactions).
Applies To: new_matter
Source Title: Live creation of a Matter for a QA contact on Fiveriverz, 2026-09-26
Related Tests: matters.create_for_new_contact
