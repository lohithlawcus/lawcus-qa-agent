# Delivery status

**As of 5 October 2026, commit `daefa72` (master).** On that commit `npm test` passes 544 unit and integration tests, `npm run test:ui` passes 10 real-Chromium UI tests, `npm run test:browser` passes 5 real-Chromium tests, and `npm run build` completes. Repo-level lint is clean for `server/`; a full `npm run lint` also scans an untracked local folder (`outputs/`), which is not part of this repository. Everything below says where its evidence comes from. Where there is none, it says so.

Evidence comes from three places:

- **This Mac's run history** (the local database, last run recorded 5 October 2026). That is real staging execution.
- **Supervised real-staging sessions** started from the workspace (for example the 5 October login run and the 4 October Teach / Record session). These are recorded in the real database.
- **Local tests**, which never touch staging.

## What this tool can do today

| Capability | Status |
| --- | --- |
| Login suite (password masked, empty fields, sign in with identity check, sign out) on staging | Working on Fiveriverz. Ran today: 4 of 4 checks passed, cleanup passed, no model calls. |
| Native Contacts and Leads checks on Fiveriverz staging (create, validate, update and restore) | Working, with one quarantined case and one failing case. Last real runs were on 23–24 September; not re-run today because they create records. |
| Contact → Matter and Matters checks | Cases are present in the real database after the service restarted. **Blocked** until `lawcus.matters.create` is approved. No real run yet on this Mac. |
| Plan a request in plain English (known patterns, or from approved Knowledge) | Working. Plans show why each check was chosen and what blocks them. |
| AI-assisted planning of login checks | Implemented, but **no model call is recorded on this Mac** and the AI switch is OFF. Standard plans need no AI. |
| Knowledge: facts with sources, scope, authority, history; bulk import; duplicate handling | Working. Nothing is trusted until you approve it. The database holds 63 facts: 25 approved, 34 pending review, 4 rejected. |
| Change loop: record a product change, see the facts and checks it touches, propose a revision | Working (app and MCP). |
| Coverage report: which checks count as coverage and why the others do not, plus a quality baseline (Safety & coverage tab) | Working. Read-only, from the run history. Today **8 of 19 checks count**. A pass only counts for 14 days, so checks that last passed on 23–24 September are now stale. The earlier figure of 14 of 19 (26 September) is out of date. |
| Read-only sweep of staging for QA records left behind | Working. Last full run 26 September 2026 (53 candidates, 50 unknown to local records). The route responds; it was not re-run today. |
| MCP server (23 tools) | Working. Exercised over stdio by the automated test suite (not run live today). |
| Teach / Record: perform a workflow once, bracketed by a draggable in-page "Start/Stop teaching" marker, and get proposals back | Working. First real session on Fiveriverz (4 October 2026, UTC): a Company-contact creation recorded exactly 4 actions (Name, Email, Phone, Save) and produced 4 `NEW_PRIMITIVE` proposals and 1 `TESTABILITY_HOOK_REQUEST` for a field with no stable locator. A recording session has no network restriction and no pinned-egress proxy; see `ARCHITECTURE.md`. |
| Preflight before a staging sign-in, and a sign-in stall diagnostic | Working. Refuses a run before it spends a sign-in if the evidence key, evidence folder, Chromium or tenant DNS is unavailable. |
| Deletion of records in staging | **Approval path proven once, end to end, on staging (5 October 2026, disposable contact).** The tool created the contact, it was recorded as owned, approved as the operator, and deleted by the approved handler (DELETE 200, verified gone). The test ran on a scratch copy of the database, so the real registry was not written. The approval screen (Run history → Records the tool created) and its one-at-a-time "Delete one approved record" button are built. The button has not yet been used against staging from the app. Only records the tool created (by exact ID), approved one at a time by a named human, and never a protected fixture. The Lawcus delete action was captured on 5 October 2026 on a disposable contact, which was then deleted. The approval screen does not exist yet. |

## What has run on real staging (this Mac's run history, 5 October 2026)

Counts include failures during development and runs on older code. Read the **last result** column as "what the most recent run of that check did", not as a pass rate for today's code.

### Fiveriverz (`lawcus`), the main staging tenant

| Check | Runs | Passed | Failed | Last run | Last result |
| --- | --- | --- | --- | --- | --- |
| `valid_login` | 29 | 23 | 6 | 2026-10-05 | passed |
| `password_masked` | 29 | 29 | 0 | 2026-10-05 | passed |
| `empty_fields` | 29 | 27 | 2 | 2026-10-05 | passed |
| `logout` | 29 | 21 | 8 | 2026-10-05 | passed |
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

## Coverage today (live report, 5 October 2026)

- **Count as coverage (8):** `auth.empty_fields`, `auth.logout`, `auth.password_masked`, `auth.valid_login`, `contacts.create_new_verifies_custom_fields`, `contacts.custom_field_update_existing`, `leads.create_new_verifies_custom_fields`, `leads.custom_field_update_existing`.
- **Stale (6):** last passed more than 14 days ago. Re-running them on staging would restore them.
- **Failing (1):** `contacts.create_new_company_verifies_custom_fields`.
- **Quarantined (1):** `contacts.create_all_fields_verified_on_detail_page`.
- **Never run on staging (3):** `auth.invalid_password` (deliberately disabled on staging) and the two Matters cases.

## Verified only in a scratch copy (not in your real history)

These were run against real staging on 26 September 2026 but written to a scratch copy of the database, so they do not appear above.

- **`matters.create_mandatory_field_validation`** passed once. It creates nothing.
- **`matters.create_for_new_contact`** passed once, after two failed attempts that exposed two real problems (both fixed): the client dropdown's "Add …" row, and a dialog locator that vanished while the picker was open. It passed with `lawcus.matters.create` approved **in the copy only**. Repeatability is not shown: a later attempt stopped at the known login stall before creating anything.
- **The staging sweep** first hit the login stall and failed cleanly, then completed in 44 seconds. It found 53 records with this tool's naming, 50 of them unknown to the local records. The list is in `work/exploration/SWEEP-2026-09-26.md`.

## Quarantined (kept, approved, and not counted as coverage)

- **`contacts.create_all_fields_verified_on_detail_page`**: its last real run failed (18 September). The Tag picker looks for `[role="option"]` but the tenant's tag chips are plain elements, and the Custom Text and Custom Matter fixes were never re-verified. It is released only after a fresh passing staging run.

## Implemented, but not run against real staging

- The login suite's rejected-account and skipped-check branches (unit-tested only).
- The Knowledge, Product-change, Staging-sweep, Facts, API Contracts and Safety & coverage screens are covered by `npm run test:ui` against a throwaway backend, for a few of their paths each.
- Personas: covered only for the refusal of an empty label. Registering a verified persona needs a visible sign-in and is checked by hand.
- Teach / Record: the refusals are automated. A real session has been run by hand on staging (see the capability table).
- The change loop's integrations (Jira, Figma, Git) do not exist. Changes are entered by hand.

## Known limits

- **Staging deletions so far:** two disposable contacts the tool created on 5 October 2026 were deleted. The first was deleted through the Lawcus UI during capture. The second went through the approved path (approval, then the approved handler) on a scratch copy of the database. The protected fixture contacts are never deletable.
- **The sweep sees only OPEN matters** (the app's default list) and matches by name only. A name is a candidate, never proof.
- **The database is at migration 25.** The service applied migrations 20–25 when it restarted on 5 October 2026.
- **Dependency audit:** the `braces` advisory (GHSA-vfj7-8cjw-p6xm) is flagged on every released version and has no fix. CI's audit gate is therefore set to `critical` (`npm audit --audit-level=critical`). The critical Next.js RCE was fixed on 4 October 2026 (PR #32).
- **Fact counts:** the 30 duplicate pending facts reported on 26 September have not been re-counted. The database now holds 34 pending facts in total.
- One Mac, one dedicated account, staging serialized. Not coverage of every Lawcus feature and not a security certification (see `COVERAGE-AND-SECURITY.md`).
- Staging logins from the one shared account have repeatedly stalled after a burst of sign-ins (cause not confirmed). Runs are capped at three per ten minutes and a sweep counts as one.

## Waiting on the operator

1. Confirm the staging password was rotated (`CREDENTIAL-INCIDENT.md` stays OPEN until then).
2. Approve `lawcus.matters.create` and the Matters→Contacts dependency. This unlocks the two Matters cases on real staging.
3. Decide whether the pending duplicate facts may be collapsed (the action is a dry run until you apply it).
4. Decide what to do about the 50 unrecorded QA records in staging, including whether cleanup may ever delete.
5. Review pull request #30, "Add AI decision safety controls and migrate model policy," which is still open.

See `OPERATOR-GUIDE.md` for how to do each of these, and `ARCHITECTURE.md` for how it fits together.
