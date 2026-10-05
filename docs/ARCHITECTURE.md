# Architecture

**As of 29 September 2026, commit `2529b3e` (baseline).** This includes the later AI safety changes in this branch. `DELIVERY-STATUS.md` says what has actually been verified on staging.

The tool is a single-user application on one Mac. A React workspace talks to a loopback control API; a Node service owns a SQLite database, a Playwright runner, the macOS Keychain helper and an MCP server. Nothing is hosted.

```
React workspace (127.0.0.1:5173)
        │  loopback API, exact Origin/Host, custom header, HttpOnly session
        ▼
Control service (127.0.0.1:4319, server/index.mjs) ── MCP server (stdio, server/mcp/server.mjs)
        │                                                    │
        ├─ SQLite (work/runtime/qa.sqlite)  ◄────────────────┘   (both open the same store)
        ├─ Playwright runners ──► staging tenant (through a pinned-IP CONNECT proxy)
        ├─ Synthetic fixture app (127.0.0.1:4320)
        └─ Keychain helper (server/native/Keychain.swift)
```

## Four ways a check runs

All four write results through the same accounting (next section).

| Path | What it is | Where |
| --- | --- | --- |
| Fixture runner | The five login checks against the local synthetic app, driven by declarative check definitions. | `runner.mjs`, `dsl.mjs`, `primitives.mjs`, `server/dsl/login/` |
| Login suite on a real tenant | The same five checks, written as browser code, on Fiveriverz, Co Server, Prod USA or Prod EU. | `live-runner.mjs` (`runLive`) |
| Native checks | Contacts, Leads and Matters checks on Fiveriverz only, each a real browser flow with a contract check. Run from a plan or by MCP. Every native check's sign-in goes through one shared helper (`live-runner.mjs`'s `withLoggedInContext`), so the egress hosts, timeouts and close order are defined once, not copied per check. | `lawcus-native-cases.mjs`, `contacts-browser.mjs`, `leads-browser.mjs`, `matters-browser.mjs`, `impacted-testing.mjs` |
| Sweep | A read-only look at the tenant's lists for QA-named records. Not a test run. | `staging-sweep.mjs`, `sweep-browser.mjs` |

The check primitives used by the fixture runner are hash-pinned: changing one stops it running until it is re-approved. That is why classification of their failures is done around them, not inside them.

## One accounting for every run

`run-outcome.mjs` decides what a finished run means, for every path above.

- **Outcomes:** `passed` (every planned check ran and passed), `failed` (at least one functional failure), `inconclusive` (nothing showed the application wrong, but a check could not complete, or nothing ran), `partial` (all that ran passed, but some planned checks did not run) and `cancelled`. A run that is not `passed` is never green, and an error or a zero-check run is never `passed`.
- **Stored status:** `runs.status` keeps the words `passed`, `failed`, `interrupted` and `cancelled`; `interrupted` means "no pass is claimed". The `outcome` and `checks_*` columns carry the truth, so nothing is inferred from a status word. The table's constraint still allows `blocked` and `needs_review` (older fixture runs could use them); none exist in this Mac's history.
- **Failure classes** (`failure-class.mjs`): every failed check gets a class and a stable reason code, stored on the result. Only `functional` says the application behaved wrongly. See the operator guide for their meanings.
- **Evidence:** each result records whether its evidence was `saved`, `save_failed` or `none_captured`. A screenshot that could not be saved makes the check not-a-pass and an `integrity` problem; it never says Lawcus failed.
- **Admission** (`run-admission.mjs`): three staging sign-ins per ten minutes (a sweep counts as one), and one run or sweep at a time. The app and MCP use the same checks.
- **Preflight** (`preflight.mjs`): before a staging sign-in is spent, the app and MCP check that the evidence key is in the Keychain, the evidence folder is writable, Chromium is installed and the tenant's hosts resolve (a DNS lookup only, nothing is sent to staging). A failure refuses the run and says what to fix.
- **Sign-in stalls:** when the workspace does not load after sign-in, the error says how long it waited and whether the browser was still on the login page (path only). The failure is classified exactly as before.
- **Code revision:** each run records the git commit of the code that produced it.

## What may reach staging

Every staging browser context restricts requests before they leave the machine, and a CONNECT proxy pins the tenant's approved public IPv4 addresses.

- **Login suite:** reads, plus the login and logout requests.
- **Contacts and Leads checks:** reads, the create and update calls those flows make, and the search calls their pickers use.
- **Matters check:** the Contacts policy plus `POST /matters`. The app's own settings write is refused.
- **Sweep:** reads, plus the three list endpoints with a paging body and nothing else. It never types into any field.

The policies are in `live-runner.mjs` (`permit*` functions). They are defense in depth, not an operating-system sandbox.

**Teach / Record is the one deliberate exception.** A recording session has no `permit*` policy and no pinned-egress proxy — by the operator's explicit decision, 2026-10-05. Every policy above restricts an *automated* script; a recording session is a person physically watching and driving the browser themselves, free to do anything they could do in Lawcus in an ordinary browser regardless of this tool. What a session produces is still never trusted or executed automatically: it only becomes a `NEW_PRIMITIVE`/`NEW_TEST`/`TESTABILITY_HOOK_REQUEST` proposal, reviewed like any other. Within a session, the operator brackets which actions matter with an in-page "Start/Stop teaching" marker (`recorder.mjs`): everything is observed, but only actions performed while the marker is on are ever recorded, so finding the right screen doesn't itself become a proposal. The marker is draggable and remembers where it was dragged to across navigations within the session (never persisted past the session).

## Records a check creates

`resource-ownership.mjs` records each record a check creates as soon as its id is known, and records a "may exist" leftover when a create was clicked but never confirmed. Cleanup is **report-only**: the cleanup runner is given no delete handlers, so nothing is deleted. Leftovers are listed for a person to resolve. Protected fixture records can never be recorded as created. The sweep looks for QA-named records the local records do not know about.

## Knowledge

Knowledge is a set of human-approved facts. The AI and MCP can only propose.

- **Facts** (`knowledge.mjs`): each has a type, a statement, a provenance, a required source, an optional scope (roles, configurations, tenants, environments), and a version history. A new version of a fact supersedes the old one only when a person approves it. Approving weaker evidence (observed, inferred or assumed) over a documented or product-approved fact needs a written acknowledgement.
- **Identity:** the same statement under a new label becomes an alias of the existing fact, not a duplicate. The same words with a different scope are a different fact. A collapse action retires pending duplicates.
- **Views** (`fact-cards.mjs`): who approved a fact, its source, where it applies, which tests assert it, its history and pending revisions.
- **Import** (`knowledge-import.mjs`): a plain-text format, atomic: one error fails the whole batch. See `server/knowledge/IMPORT_TEMPLATE.md`.
- **Dependency graph** (`graph-planner.mjs`): relations between features are directed; each type says which way a change flows and whether one feature needs the other set up first. Only approved relations are used. Pending ones become review requests.
- **Planning** (`impacted-testing.mjs`, `graph-planner.mjs`): a request that matches a hand-written pattern runs that pattern; otherwise a request naming a feature is planned from approved Knowledge. A plan states why each check was chosen, what must be set up, and what blocks it. Destructive or non-testing requests are never planned, and a blocked plan is never run.
- **Change loop** (`change-signals.mjs`): a recorded product change is analysed against approved facts and checks. A person may then file a pending revision, flag a fact for re-review, or dismiss the change. Nothing changes a fact or a test by itself.

## Coverage report

`coverage-report.mjs` reads the run history and changes nothing. It says which checks **count as coverage** on the main staging tenant: a pass within 14 days that is the latest result that counts. Every other check gets a reason (stale, failing, never conclusive, never run on staging, quarantined, not approved). A result counts when it passed or failed in a way that says Lawcus was wrong. Failures blamed on the environment, the tool or storage count neither way. Failures recorded before classification existed have no cause on record, so they count against the check.

It also gives a 90-day quality baseline: failures by class with their denominators, run outcomes, and checks that both passed and failed on the same code. Fixture runs are excluded. It includes runs made while the tool was being built, so it is a baseline to compare against, not today's pass rate. The workspace shows it at the top of **Safety & coverage**.

## AI use

AI is used only to plan login checks, through a router that names the provider and model (`server/ai/router.mjs`: OpenAI, `gpt-6-luna`). The request uses the Responses API with storage disabled and strict validated JSON. Only the operator's request text and the fixed login contract are sent, never browser contents, credentials or evidence. A guard refuses a request that contains anything credential-shaped. No model-generated code or assertion is ever executed, and browser execution and replay use zero model calls. Every model call is logged, and the **AI switch** (`/ai-gate`) can turn all AI use off; the standard plan needs no AI.

The AI Gate records a started event before each model request and a completed or failed event afterward. A local SHA-256 chain links salted hashes and bounded metadata without storing prompts or responses. It detects accidental or partial edits to these rows; anyone able to rewrite the database can recompute the hashes, so this is not immutable storage. The gate refuses model calls if ledger verification fails, if an unknown AI task is requested, after three provider/validation failures in ten minutes, or after 20 model requests in one hour. These conditions open a persisted circuit and an incident visible in AI Usage. A human operator must re-enable AI to reset the pause. Operator-disabled AI stays disabled across migrations and restarts. Residual risks are listed in `ai_residual_risks`; the initial entries do not claim to be a complete risk assessment.

## MCP tools

The MCP server exposes exactly these tools. None of them approves, rejects, flags, resolves, dismisses or deletes anything.

`search_lawcus_knowledge`, `get_feature_rules`, `find_affected_features`, `find_relevant_test_suites`, `read_test_case`, `read_api_contract`, `create_test_proposal`, `create_failure_analysis_proposal`, `list_pending_proposals`, `run_approved_test`, `run_approved_suite`, `get_run_status`, `get_run_results`, `get_failure_evidence_summary`, `list_facts`, `get_fact`, `list_stale_facts`, `get_coverage_report`, `plan_test_request`, `list_change_signals`, `get_change_signal`, `submit_change_signal`, `propose_fact_revision`

The MCP identity (`mcp`) is a non-human identity. A revision it files may claim only observed, inferred or assumed evidence, and submissions are capped at 30 per hour.

## Secrets and redaction

Credentials live in macOS Keychain (the staging accounts, the OpenAI key and the evidence key). They are never in SQLite or process arguments. `redact.mjs` masks credentials in audit events, stored results and reasons, error responses, MCP results, captured console output and change signals, and password inputs are masked in screenshots. It masks values the process has read plus credential-shaped text. It cannot recognise a secret that was never read from the Keychain and has no label around it. Staging evidence is AES-256-GCM encrypted at rest; a download makes a decrypted copy.

## HTTP routes

The control service serves these route families. Every browser request needs the exact UI origin, the custom header and a session.

| Route | Purpose |
| --- | --- |
| `/session` | open a local session |
| `/state` | everything the workspace shows |
| `/setup` | credentials, browser sign-in, status |
| `/runner/check` | check the browser |
| `/plans` | plan a login test |
| `/runs` | start, read and cancel runs |
| `/impacted-tests` | plan and run native checks |
| `/proposals` | review proposals |
| `/knowledge` | import, review, facts, duplicates, stale facts |
| `/change-signals` | record and review product changes |
| `/api-contracts` | API contracts and their approval |
| `/network-authorities` | approved network authority |
| `/environment-adapters` | approved environment adapters |
| `/personas` | verified personas |
| `/authoring` | teach / record sessions |
| `/leftovers` | records a run left behind |
| `/sweeps` | read-only staging sweep |
| `/coverage` | read-only coverage and quality report from the run history |
| `/clarifications` | answer a clarification |
| `/artifacts` | download evidence |
| `/ai-gate` | switch AI use on or off |

## Database migrations

The service applies these in order at startup. The schema version is the highest number applied.

| Migration | Adds |
| --- | --- |
| `001_initial.sql` | runbooks, runs, results, audit |
| `002_idempotency.sql` | idempotent run requests |
| `003_environment_confirmation.sql` | environment confirmations |
| `004_proposals.sql` | proposals |
| `005_testbook.sql` | features, suites, test cases and versions |
| `006_execution_manifest.sql` | frozen execution manifests |
| `007_intent_router.sql` | request routing |
| `008_model_usage.sql` | model call log |
| `009_knowledge_graph.sql` | facts and the relation graph |
| `010_api_contracts.sql` | API contracts |
| `011_network_observer.sql` | network observations |
| `012_personas.sql` | personas |
| `013_resource_locks.sql` | ownership and resource locks |
| `014_authoring_sessions.sql` | teach / record sessions |
| `015_knowledge_structured_fields.sql` | structured fact fields |
| `016_impacted_testing_origin.sql` | impacted testing as a proposal origin |
| `017_mcp_origin.sql` | MCP as a proposal origin |
| `018_ai_gate.sql` | the AI switch |
| `019_multi_environment.sql` | several environments |
| `020_truthful_run_accounting.sql` | outcome, counts, evidence status, quarantine, code revision |
| `021_knowledge_aliases.sql` | fact aliases |
| `022_change_signals.sql` | change signals and review flags |
| `023_failure_classes.sql` | failure class and reason code on results |
| `024_fact_scope.sql` | fact scope |
| `025_staging_sweeps.sql` | sweeps and their findings |
| `026_ai_safety.sql` | AI decision integrity chain, circuit state, incidents and residual risks |

## Where things are

`server/index.mjs` is the control API. `server/core/` holds the runners, accounting, policies and Knowledge. `server/mcp/` is the MCP server. `server/testbook/` registers the native checks and what each provisions. `server/knowledge/` and `server/api-contracts/` hold the seeds. `app/` and `components/` are the workspace. `server/tests/` holds the tests; `npm test` runs the unit and integration tests, `npm run test:browser` runs the real-Chromium runner tests, and `npm run test:ui` drives the workspace against a throwaway backend (nothing reads the Keychain or reaches staging).
