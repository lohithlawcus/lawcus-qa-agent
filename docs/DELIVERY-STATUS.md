# Delivery status

**As of 26 September 2026, commit `262dcab` (master).** On that commit `npm test` passes 497 tests, `npm run test:browser` passes 5 real-Chromium tests, and lint and typecheck are clean. Everything below says where its evidence comes from. Where there is none, it says so.

Evidence comes from three places:

- **This Mac's run history** (the local database, last run recorded 24 September 2026). That is real staging execution.
- **Supervised runs in a scratch copy** of that database. Real staging was used, but the result was not written to the real database.
- **Local tests**, which never touch staging.

## What this tool can do today

| Capability | Status |
| --- | --- |
| Login suite (password masked, empty fields, sign in with identity check, sign out) on staging | Working on Fiveriverz. See the history below. |
| Native Contacts and Leads checks on Fiveriverz staging (create, validate, update and restore) | Working, with one quarantined case. |
| Contact → Matter check (creates its own contact, then a Matter, and verifies the link) | Implemented and run in a scratch copy only. Not in the real history. Needs a contract approval first. |
| Plan a request in plain English (known patterns, or from approved Knowledge) | Working. Plans show why each check was chosen and what blocks them. |
| AI-assisted planning of login checks | Implemented, but **no model call is recorded on this Mac** and the AI switch is currently OFF (turned off on 17 September). Standard plans need no AI. |
| Knowledge: facts with sources, scope, authority, history; bulk import; duplicate handling | Working. Nothing is trusted until you approve it. |
| Change loop: record a product change, see the facts and checks it touches, propose a revision | Working (app and MCP). |
| Read-only sweep of staging for QA records left behind | Working. Run once in a scratch copy. |
| MCP server (22 tools) | Working. Exercised over stdio against a copy of the real database. |
| Cleanup of records in staging | **Not implemented.** Records are tracked and reported, never deleted. |

## What has run on real staging (this Mac's run history)

Counts include failures during development and runs on older code. Read the **last result** column as "what the most recent run of that check did", not as a pass rate for today's code.

### Fiveriverz (`lawcus`), the main staging tenant

| Check | Runs | Passed | Failed | Last run | Last result |
| --- | --- | --- | --- | --- | --- |
| `valid_login` | 28 | 22 | 6 | 2026-09-23 | passed |
| `password_masked` | 28 | 28 | 0 | 2026-09-23 | passed |
| `empty_fields` | 28 | 26 | 2 | 2026-09-23 | passed |
| `logout` | 28 | 20 | 8 | 2026-09-23 | passed |
| `contacts.create_new_verifies_custom_fields` | 12 | 8 | 4 | 2026-09-23 | passed |
| `contacts.custom_field_update_existing` | 18 | 11 | 7 | 2026-09-24 | passed |
| `contacts.custom_field_update_existing_company` | 2 | 1 | 1 | 2026-09-16 | passed |
| `contacts.create_new_company_verifies_custom_fields` | 1 | 0 | 1 | 2026-09-16 | **failed** |
| `contacts.create_mandatory_field_validation` | 1 | 1 | 0 | 2026-09-16 | passed |
| `contacts.create_company_mandatory_field_validation` | 1 | 1 | 0 | 2026-09-16 | passed |
| `contacts.create_phone_number_validation` | 1 | 1 | 0 | 2026-09-17 | passed |
| `contacts.create_billing_rate_required_validation` | 3 | 1 | 2 | 2026-09-17 | passed |
| `contacts.create_all_fields_verified_on_detail_page` | 8 | 2 | 6 | 2026-09-18 | **failed (quarantined)** |
| `leads.create_new_verifies_custom_fields` | 10 | 8 | 2 | 2026-09-23 | passed |
| `leads.create_mandatory_field_validation` | 1 | 1 | 0 | 2026-09-16 | passed |
| `leads.custom_field_update_existing` | 11 | 9 | 2 | 2026-09-23 | passed |
| `matters.create_for_new_contact` | 0 | 0 | 0 | none | see below |
| `matters.create_mandatory_field_validation` | 0 | 0 | 0 | none | see below |

The incorrect-password check is deliberately disabled on staging until the account's lockout limits are known. It runs only on the local fixture.

### Other tenants (login suite only)

These have run only the login suite, all on 17 September, and only a handful of times (Prod USA 4 runs, of which 3 were interrupted and 1 passed; Co Server 2 runs; Prod EU 2 runs). The table counts individual checks. Do not treat these tenants as verified.

| Tenant | `valid_login` | `logout` | `password_masked` | `empty_fields` |
| --- | --- | --- | --- | --- |
| Prod USA | 1 of 1 passed | 1 of 1 passed | 1 of 1 passed | 1 of 1 passed |
| Co Server | 0 of 2 (last: **failed**) | 0 of 2 (last: **failed**) | 1 of 2 | 2 of 2 |
| Prod EU | 0 of 2 (last: **failed**) | 0 of 2 (last: **failed**) | 1 of 2 | 1 of 2 |

### Local synthetic fixture

Ten runs: nine passed and one was cancelled. The last run was on 16 September. The five login checks passed on every fixture run.

## Verified only in a scratch copy (not in your real history)

These were run against real staging on 26 September 2026 but written to a scratch copy of the database, so they do not appear above.

- **`matters.create_mandatory_field_validation`** passed once. It creates nothing.
- **`matters.create_for_new_contact`** passed once, after two failed attempts that exposed two real problems (both fixed): the client dropdown's "Add …" row, and a dialog locator that vanished while the picker was open. It passed with `lawcus.matters.create` approved **in the copy only**. Repeatability is not shown: a later attempt stopped at the known login stall before creating anything.
- **The staging sweep** first hit the login stall and failed cleanly, then completed in 44 seconds. It found 53 records with this tool's naming, 50 of them unknown to the local records. The list is in `work/exploration/SWEEP-2026-09-26.md`.

## Quarantined (kept, approved, and not counted as coverage)

- **`contacts.create_all_fields_verified_on_detail_page`**: its last real run failed (18 September). The Tag picker looks for `[role="option"]` but the tenant's tag chips are plain elements, and the Custom Text and Custom Matter fixes were never re-verified. It is released only after a fresh passing staging run.

## Implemented, but never run against real staging

- The login suite's rejected-account and skipped-check branches (unit-tested only).
- The Facts, Product-change and Staging-sweep screens were checked in a browser against a copy of the real data, but have no automated UI tests.
- The change loop's integrations (Jira, Figma, Git) do not exist. Changes are entered by hand.

## Known limits

- **Records created in staging are never deleted.** Cleanup has no delete handlers, because it was never decided whether this tool may delete staging records. Each check records what it creates; leftovers are listed for you to resolve.
- **The sweep sees only OPEN matters** (the app's default list) and matches by name only. A name is a candidate, never proof.
- **The Matters feature and the Matters→Contacts dependency exist only after the service restarts.** This Mac's database has not been migrated past version 19; the service applies migrations 20–25 on its next start.
- No edges in the dependency graph are approved yet, so the graph planner mostly plans a feature on its own.
- 14 older facts have no recorded source (7 approved).
- One Mac, one dedicated account, staging serialized. Not coverage of every Lawcus feature and not a security certification (see `COVERAGE-AND-SECURITY.md`).
- Staging logins from the one shared account have repeatedly stalled after a burst of sign-ins (cause not confirmed). Runs are capped at three per ten minutes and a sweep counts as one.

## Waiting on the operator

1. Confirm the staging password was rotated (`CREDENTIAL-INCIDENT.md` stays OPEN until then).
2. Restart the service so migrations 20–25 run on the real database.
3. Approve `lawcus.matters.create` and the Matters→Contacts dependency, and confirm the three older pending dependencies.
4. Decide whether the 30 duplicate pending facts may be collapsed (the action is a dry run until you apply it).
5. Decide what to do about the 50 unrecorded QA records in staging, including whether cleanup may ever delete.

See `OPERATOR-GUIDE.md` for how to do each of these, and `ARCHITECTURE.md` for how it fits together.
