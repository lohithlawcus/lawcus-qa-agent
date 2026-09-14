# Lawcus QA Agent

Local V1 login testing for the authorized staging workspace `https://lohith.fiveriverz.com` and an isolated synthetic fixture. This is a bounded implementation, not coverage of every Lawcus feature or a security certification.

## Start on this Mac

Double-click `outputs/Start Lawcus QA Agent.command` **in Finder**, then keep its Terminal window open. The launcher selects a compatible installed Node.js version and opens http://127.0.0.1:5173/. Opening the command file as a document in Codex does not start the app. Node.js 24 LTS is recommended; Node >=22.13 is required. Apple Command Line Tools build the macOS Keychain helper. Chromium must be installed using the matching Playwright version.

1. Under Environment, use **Sign in and save verified account** to sign in yourself in a separate Chromium window, then open the profile menu. The app verifies the authenticated workspace and account identity before saving credentials in macOS Keychain. Alternatively, use the credential fields; saving through those fields alone is not proof that authentication works.
2. Click Check browser connection. A successful check verifies Chromium launch only.
3. In Workspace, choose Lawcus staging and Use standard login checks. Review the four fixed expectations and start the run. This mode needs no API key and makes no AI calls.
4. To use English AI planning, enable OpenAI API billing, create an API key, and save it under Environment. Create test plan then uses OpenAI. No automatic paid fallback exists.
5. Review actual results and encrypted evidence. Rerun the saved test to verify replay. A failure never changes the expected result automatically.

## Scope

Staging supports password masking, empty-field validation, dedicated-account login with identity verification, and browser logout followed by a protected-route check. Incorrect-password testing is disabled until account lockout limits are confirmed. The local fixture includes an incorrect-password check. Staging logout does not prove server-wide token revocation.

The OpenAI planner uses the Responses API, `gpt-4.1-mini`, `store:false`, a bounded output budget and strict validated JSON. Only operator intent and the fixed login contract go to the model. Browser contents, account credentials and evidence are not sent. Do not enter secrets or customer records in test instructions. Browser execution and saved-path replay use zero model calls.

## Storage and boundaries

The service binds to 127.0.0.1:4319 and the fixture to 127.0.0.1:4320. Exact Host/Origin checks, a custom header and an HttpOnly SameSite cookie protect browser access. This is a single-user Mac application, not protection against hostile software running under the same Mac account. Do not expose these ports publicly.

Runbooks, intents, results and audit metadata are stored in SQLite under `work/runtime/` with private permissions. The database is not encrypted: it must not contain credentials or legal/customer records. Staging passwords, the OpenAI key and an evidence encryption key are stored in macOS Keychain. Staging screenshots and redacted JSON execution traces use AES-256-GCM at rest. Downloading creates a decrypted copy controlled by the operator; automated retention is not implemented. Raw Playwright traces are permitted only for the synthetic fixture because they can include credentials and session tokens.

A CONNECT proxy pins approved public IPv4 addresses for the staging tenant, its observed API and asset host. Request routing further limits methods, and service workers, WebSockets and downloads are disabled. This is defense in depth, not an independently enforced OS network sandbox. SSO/RBAC, multiple users, suites, knowledge ingestion, automatic business-rule changes, hosted workers and broader Lawcus flows remain future scope.

## Engineering verification

`npm ci`; `npx playwright install chromium`; use the launcher or run `npm run qa:service` and `npm run dev` with a compatible Node. `npm test` checks policies, persistence, encryption tamper detection and mocked AI responses without reading real credentials or spending API credit. `npm run test:api` checks a running local service without creating paid AI plans. `npm run test:browser` requires a browser-capable environment and checks actual fixture execution, replay, alias repair and business-defect detection. `npm run lint`, `npm run typecheck` and `npm run build` validate source and interface. Browser tests fail rather than skip when Chromium is unavailable.

See `docs/DELIVERY-STATUS.md` for evidence-backed status and `docs/COVERAGE-AND-SECURITY.md` for missing cases.
