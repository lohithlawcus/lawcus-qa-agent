# Missing cases and release gates

No finite test suite proves that every case is covered or that security lapses are impossible. Track tested requirements, evidence, uncertainty and exclusions explicitly. Prioritize by impact and likelihood; require human review before widening autonomous authority.

**As of 26 September 2026, commit `262dcab`.** The lists below are what should eventually be covered. The next table says where each area stands today. "Covered" means an automated test exists for it; it does not mean it was tested on real staging (see `DELIVERY-STATUS.md`).

| Area | Status | Where it stands |
| --- | --- | --- |
| Cross-tenant and cross-role access, guessed IDs, disabled users | Not covered | One dedicated account only. |
| Prompt injection | Partial | Only the request text and the fixed login contract go to the model; no page content does, and no model output is executed. There is no injection test corpus. |
| SSRF and network egress | Partial | Approved public IPs are pinned; private or mixed DNS answers, redirects and IPv6 addresses are rejected (tested). Popups, iframes, WebSockets, service workers and downloads are blocked in code but have no dedicated tests. Not an operating-system sandbox. |
| Secrets in logs, errors, results, MCP output, screenshots | Partial | Masked at the boundaries that store or return text (tested, with mutation checks). A secret never read from the Keychain and with no label around it cannot be recognised. Text stored before redaction existed is not rewritten. The credential incident is still OPEN. |
| Production mislabeled as staging; irreversible actions | Partial | Writes happen only on the Fiveriverz staging tenant. Prod USA and Prod EU are configured as login-suite targets (sign-in and read only). The tool never deletes anything in Lawcus and its MCP interface has no decision tools. |
| Local API: CSRF, session, request limits | Partial | Exact Origin and Host, a custom header, an HttpOnly session, bounded bodies (tested). No XSS review. |
| Wrong-element healing, approval by the wrong actor | Partial | No automatic repair: a locator change is only a proposal. Approvals need a human identity (tested), and the MCP identity is refused at every decision point. |
| Login: valid login, masking, empty fields, logout | Covered on Fiveriverz | Real staging history exists. Logout checks only this browser's access, not server-wide revocation. |
| Login: invalid password | Fixture only | Disabled on staging until lockout limits are known. |
| MFA, SSO, CAPTCHA, lockout, session expiry, cookie flags | Not covered | |
| Worker crash, restart, duplicate submission, idempotency | Covered locally | A run left running by a crash is closed at startup; run requests are idempotent (tested). |
| Cancellation | Fixture only | The fixture runner honours a cancel between checks. |
| Cleanup and ownership | Partial | Created records are recorded and leftovers reported (tested). Deletion needs a named human approval for each record, and never a name match; that approval gate is tested. No Lawcus delete action has been verified or run yet. |
| Knowledge: source conflicts, inference promoted to fact, stale facts, circular dependencies | Partial | Weaker evidence needs a written acknowledgement to replace stronger; stale facts are listed; cycles block a plan (all tested). A second approval of the same item is refused (tested). |
| No silent retries, no false green | Covered | See the run accounting in `ARCHITECTURE.md`. The single login retry in native checks is recorded. |
| Billing, dates and time zones, accessibility, integrations, AI failure modes | Not covered | Only login, Contacts, Leads and one Matter flow exist. |

## P0 — security and irreversible impact

- Cross-tenant and cross-role reads, writes, artifact download and clarification approval; guessed IDs; stale role/session and disabled users.
- Prompt injection in DOM, accessibility labels, screenshots, documents, tickets, retrieved memory and model output; no authority from retrieved content.
- SSRF: metadata endpoints, loopback/private/link-local IPv4/IPv6, encoded hosts, DNS rebinding, redirects, popups, iframes, downloads, WebSockets and service workers; verify at the network boundary.
- Secrets in logs, input text, screenshots, traces, network headers, query strings, artifacts, browser storage, model prompts and error messages; redaction failure must stop export.
- Production mislabeled staging; shared/customer fixtures; external email/SMS/webhooks, payments, bulk deletes and irreversible legal workflows; deny until explicit scoped authority.
- CSRF, XSS, session fixation, logout/revocation, expired approvals, replayed callbacks, request/body limits and rate limiting.
- Healing a wrong element, duplicate labels, confidence miscalibration, unchanged text with changed meaning, financial drift, assertions removed by model, approval by unauthorized actors.

## P1 — identity and login

- Valid login, invalid credentials, empty and malformed input, whitespace/case rules, Unicode, long inputs, password masking, enter-key submit, keyboard access and screen-reader labels.
- MFA, SSO, CAPTCHA and email verification pause safely; do not bypass controls. Account lockout, rate limiting and retry budgets require dedicated accounts and known limits.
- Session fixation, cookie flags, logout invalidation, session expiry, remember-me, multi-tab behavior, concurrent sessions, revoked accounts, cross-tenant user identity and open redirects.
- Offline, slow responses, HTTP errors, TLS failures, interrupted navigation, redirect loops, ambiguous elements and loading races.
- Never infer login success from URL change alone. Assert an authoritative authenticated state; never infer denial merely from failure to navigate.

## P1 — execution and knowledge

- Worker crash, cancellation, partial completion, stale lease, duplicate submission, idempotency conflict, restart recovery and exhausted model/time/browser budgets.
- Save runbook/path transaction failures, evidence write failures, disk full, corrupted records, stale versions, conflicting edits and orphaned artifacts.
- Fixture collisions, cleanup ownership, partial setup/cleanup, retention and reaper restart; never delete by name prefix alone.
- Business-rule source conflict, stale release/environment, inference promoted to fact, circular dependencies, incomplete impact graph and concurrent approval.
- No silent retries or false green runs. `passed`, `failed`, `inconclusive`, `partial` and `cancelled` are distinct outcomes, a failed check says what kind of failure it was, and clarifications are recorded. Quarantined/flaky cases still affect release confidence.

## P2 — expansion

- Billing: decimal precision, currency scale, rounding order, discounts/taxes, partial/refunded payments, negative values, zero totals, concurrent updates and independent expected calculations.
- Date/time: UTC offsets, DST gaps/repeats, leap days, inclusive ranges, midnight, locale and server/client timezone differences.
- Accessibility, 200% zoom, small screens, browsers, keyboard focus, responsive overflow and readable errors.
- Integrations: schema changes, pagination, webhook signatures/replay, eventual consistency, stale caches, ordering, rate limits and outages.
- AI: malformed output, injection, hallucinated rules, contradictory plans, truncation, unavailable provider, cost accounting and data residency.

## Remaining validation and broader release gates

1. Staging and dedicated account availability are user-confirmed. Verify account permissions and observe the expected login behavior.
2. Local Keychain and encrypted staging evidence are implemented. SSO/RBAC, production database, tenant separation and retention are required for a broader release.
3. A pinned-public-IP CONNECT proxy and browser route restrictions are implemented. Independently enforced OS egress isolation is still required for hosted or multi-user workers.
4. Complete threat-model review, dependency audit, authorization negative tests, backup/restore drill and independent security review.
5. Demonstrate real staging execution and replay using authorized credentials; document exclusions and residual risk.

References: OWASP SSRF Prevention Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html); Playwright network interception and service-worker limitations (https://playwright.dev/docs/network).

## Automated checks today

At commit `262dcab`, `npm test` runs 497 unit and integration tests and `npm run test:browser` runs 5 real-Chromium tests against the synthetic fixture, including negative controls (a real defect, a page that cannot be driven, a fixture that is down, unwritable evidence). The tests cover request policies, persistence and recovery, idempotency, private and mixed DNS rejection, evidence encryption including wrong-key and tamper failures, mocked AI output validation, redaction at each boundary, run accounting and failure classification, ownership and leftovers, Knowledge identity, scope and authority, the planner, the change loop, the MCP server over stdio and the sweep's read-only policy. Many of these were also checked by deliberately breaking the code (mutation checks) to confirm a test fails.

These are implementation checks, not a penetration test of Lawcus. Where real staging was involved, `DELIVERY-STATUS.md` says which checks ran, when, and with what result.
