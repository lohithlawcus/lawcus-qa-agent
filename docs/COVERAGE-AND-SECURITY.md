# Missing cases and release gates

No finite test suite proves that every case is covered or that security lapses are impossible. Track tested requirements, evidence, uncertainty and exclusions explicitly. Prioritize by impact and likelihood; require human review before widening autonomous authority.

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
- No silent retries or false green runs. Passed, failed, blocked, interrupted and clarification are distinct. Quarantined/flaky cases still affect release confidence.

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

## Implemented automated checks in this update

Seventeen tests cover schema/injection boundaries, fixture request policy, persistence recovery and idempotency, staging request restrictions, private/mixed DNS rejection, authenticated evidence encryption including wrong-key/tamper failures, mocked AI output validation and API error handling. These are implementation checks, not a penetration test of Lawcus. Actual staging first execution and saved-path replay both passed all four login checks; all 16 encrypted evidence files were retrieved. Negative-password, lockout, MFA/SSO, server token revocation, account privilege and cross-tenant authorization tests are not covered by the four staging checks.
