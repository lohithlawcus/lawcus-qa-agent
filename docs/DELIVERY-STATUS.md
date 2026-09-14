# Delivery status — 11 September 2026

The local V1 **standard login workflow is working on the authorized Lawcus staging environment**. Live AI planning is implemented but its single approved verification request returned an OpenAI quota/rate-limit error. No AI plan was saved and no automatic retry was made.

## Verified staging results

| Check | First run | Saved-path replay |
| --- | --- | --- |
| Password masking | Passed | Passed |
| Empty-field validation, with no login submission | Passed | Passed |
| Dedicated-account login and profile identity | Passed | Passed |
| Logout followed by a protected-route check | Passed | Passed |

First run: `6d9d8c9d-940b-41dc-aa07-70a0814c4de1`.
Replay: `f0423aaf-3f08-4a1f-81ec-5828e834bc05`.

Both runs used zero model calls. All 16 encrypted evidence files across the two runs were successfully retrieved. Logout checks this browser's access after signing out; it does not establish server-wide token revocation.

The working dedicated account was verified through operator-driven sign-in and profile-menu inspection, then saved in macOS Keychain. A boolean comparison confirmed it differed from the earlier saved credentials. Secret values were not included in status, audit records or reports.

## Other verification

- The synthetic fixture passed all five checks on first execution and saved-path replay; all 20 evidence files were retrieved.
- 17 automated policy, persistence, encryption and mocked AI tests pass.
- Two running-API test groups pass, including setup authorization, malformed cookies, exact Host/Origin checks and strict credential fields.
- TypeScript, ESLint and the production build pass.
- The native Keychain helper compiles; Chromium launches through the user-started local service.
- Eleven earlier staging clarification records now contain evidence-backed technical resolutions. Original failed run records remain intact.

The separate browser integration test for deliberately simulated alias repair and business-defect detection still needs execution in a permitted browser-test environment. Successful first execution and replay above were verified through the actual app API; they do not establish that every browser integration case passed.

## Implemented boundaries

The launcher selects a compatible installed Node version, binds services to loopback and keeps startup errors visible. Browser calls require the exact UI Origin, service Host, custom header and local session. The UI recovers expired local sessions and refreshes run history.

Each staging check gets a fresh Chromium process and isolated context. A CONNECT proxy pins approved public IPv4 addresses for the staging tenant, observed API and asset CDN. Route policy restricts mutations; the observed `POST /forcelogout` endpoint is permitted only during the logout step, once. Service workers, WebSockets and downloads are disabled. Wrong-password testing is disabled. One active run, idempotency keys, bounded run frequency and no automatic authentication retries limit repeated activity.

Passwords, the API key and evidence key reside in macOS Keychain. Staging screenshots and redacted execution traces are encrypted with AES-256-GCM at rest. Downloads create decrypted operator-controlled copies. Raw Playwright traces remain synthetic-fixture-only. SQLite metadata is not encrypted and must not contain secrets or customer records.

The visible connection flow lets the operator sign in and open their profile menu. Only after authentication, staging workspace and account email are verified does it save the working account. It supports cancellation, bounded waiting and one submission per connection attempt.

## AI status and next step

The API key is saved in Keychain. One explicitly approved real request was made; the app reported an OpenAI quota/rate-limit error. Its previous generic error handling did not retain the specific provider code, so an exhausted balance cannot be distinguished from a temporary rate limit or spending limit for that request. New error handling distinguishes known provider codes without exposing raw provider messages; it has been verified with mocked responses, not another paid request.

Check the API organization's billing balance and organization/project limits before retrying. ChatGPT subscription billing is separate from API billing. The standard checks remain available without an AI call.

## Remaining scope

This is one Mac and a bounded login contract. It is not complete Lawcus coverage or a security certification. Cross-tenant/role authorization, lockout, MFA/SSO, cookie hardening, session expiry, server-wide revocation, retention, backup/restore, independently enforced OS worker isolation and external security review remain outside the verified slice. Knowledge ingestion, suites, financial checks, applying business-rule amendments, hosted workers and multiple-user access control remain future scope.
