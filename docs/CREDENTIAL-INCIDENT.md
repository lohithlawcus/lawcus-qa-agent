# Credential incident: closure record

**Status: OPEN — code containment done; operator confirmation still required.**

This file records the state of the reported test-credential exposure. It
contains no credential, e-mail address or key, and must never be edited to
include one.

## What is closed (code, verified by tests)

Every path that stores or returns text derived from a browser, a request or an
error now goes through `server/core/redact.mjs`:

| Boundary | Protection |
|---|---|
| Audit events (`store.mjs`) | values masked; secret-named keys hidden |
| Stored/returned check results and reasons (`impacted-testing.mjs`) | masked before insert and before return |
| Run crash summaries (`run-outcome.mjs`) | `safeErrorMessage` |
| HTTP error bodies (`index.mjs` `json()`), authoring/proposal errors | `sanitizeErrorBody` / `safeErrorMessage` |
| MCP tool results and errors (`mcp/results.mjs`) | values masked |
| Captured console / page errors (`network-observer.mjs`) | masked before kept |
| Model prompts (`ai/providers/openai.mjs`) | rejected if `containsSecret` |
| Evidence screenshots (`evidence.mjs`) | password inputs masked |
| Keychain reads/writes (`secrets.mjs`) | value registered for exact-match masking |

Verification: 25 dedicated tests, full suite 337/337, and 16 mutations
(each safeguard removed in turn) each fail a specific test.

## Known limits (stated, not hidden)

- A secret that was never read from or saved to the Keychain by this process
  **and** has no label around it cannot be recognised. Playwright's own error
  text (typed value in a failed `fill()`) is covered by the call-log pattern.
- Text already stored **before** this change is not rewritten by it.
- The HTTP layer was checked by static assertion plus mutation, and a smoke
  run of an isolated instance; no route that echoes request text was reached
  in that smoke run.

## What is NOT closed (needs the operator)

1. **Rotation:** whether the exposed staging password was rotated is
   unconfirmed. Until the operator confirms rotation, this incident stays OPEN.
2. **Pre-existing stored data:** the operator should decide whether to inspect
   older run/audit records for exposure. That inspection is read-only.

## To close

Record here, with a date, only: "rotation confirmed by <operator>" and, if
done, "historical records reviewed". Then change the status line above.
