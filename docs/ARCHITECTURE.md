# Local V1 architecture

React workspace → loopback control API → SQLite runbooks/results/audit → deterministic Playwright runner → encrypted staging evidence. macOS Keychain provides staging credentials, the OpenAI key and the evidence encryption key. No hosted deployment is required or enabled.

## Planning and execution

OpenAI receives only operator intent and the fixed login contract using the Responses API with structured output and storage disabled. Strict schema checks reject extra fields, unknown scenarios and duplicates. Unsupported behavior requests return clarification; incorrect-password checks cannot execute on staging. No model-generated code or assertion is executed. A separately labeled standard plan provides four fixed staging checks without AI. The synthetic fixture has its own bounded parser and five checks.

The operator reviews a saved logical plan before execution. Each scenario gets a fresh browser context. Login success requires the protected workspace and the dedicated account identity, not a URL change alone. Logout checks that this browser cannot revisit a protected page; it does not establish server-wide token revocation. A unique semantic locator change can be saved only after unchanged authentication assertions pass. Failure records clarification without rewriting expectations. Replay reads persisted paths and makes no model calls.

## Local security boundaries

Only the exact local UI Origin and service Host are accepted. Browser calls require a custom header and an HttpOnly same-site session. API bodies are bounded, run requests have idempotency keys, and one run is active at a time. Interrupted jobs remain interrupted after restart. Credential updates cannot overlap an active run; browser checks cannot overlap another runner operation. Three staging runs per ten minutes bound repeated authentication; a failed authentication check stops further account attempts within that run.

Staging request authority is fixed in code: the authorized tenant, observed authentication API and exact asset CDN. HTTPS CONNECT resolves approved hosts to public IPv4 addresses and pins them for a run, rejecting private or mixed DNS answers. Browser routing restricts mutation requests to login/logout. Service workers, WebSockets and downloads are disabled. These controls do not replace OS-level isolation against browser compromise or malicious code under the same Mac user.

The Keychain helper only addresses three application-owned secret names and communicates through private pipes. Secret values are not passed in process arguments or stored in SQLite. Screenshots mask input fields, then are encrypted in memory before disk writes. Staging traces contain only fixed action summaries and blocked hosts, not raw DOM, headers, bodies or tokens. AES-256-GCM detects evidence tampering. Downloads decrypt evidence into an operator-controlled copy.

## Persistence and limitations

SQLite stores environment confirmations with user provenance, logical plans, versioned semantic paths, run results, artifact references, clarification answers and audit events. Runtime data is excluded from source exports. SQLite metadata is not encrypted, so operators must not enter secrets or customer information in intent/clarification fields. Evidence retention, cancellation, backup/restore, multiple-account isolation, hosted identity/RBAC, suites, financial assertions, knowledge ingestion and applying business-rule amendments remain unimplemented.

Key source modules: `server/index.mjs` (control API), `contracts.mjs` (schemas/fixture contract), `ai-planner.mjs`, `live-runner.mjs`, `runner.mjs` (fixture), `egress.mjs`, `setup.mjs`, `secrets.mjs`, `store.mjs`, and `server/native/Keychain.swift`.

## Operator-driven connection

The Environment view can open a separate, restricted Chromium window for the operator to sign in manually. It captures only the credential fields submitted to the fixed staging login endpoint in process memory, waits for successful authentication and the unchanged account-identity assertion, and only then saves the working account in Keychain. It reports whether it matched the previously saved account as a boolean, never the credential values. Concurrent runs and credential changes are blocked during connection. One submission per attempt, three connection starts per ten minutes, cancellation and a three-minute timeout bound this flow. This connection is not a test pass or a replacement for subsequent deterministic replay.
