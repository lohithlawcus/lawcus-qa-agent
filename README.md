# Lawcus QA Agent

A local tool that runs browser checks against the authorized Lawcus staging tenant (`https://lohith.fiveriverz.com`) and a synthetic fixture app, keeps encrypted evidence, and keeps a human-approved list of what Lawcus is supposed to do. It runs on one Mac for one operator. It is **not** coverage of every Lawcus feature and **not** a security certification.

**Status as of 26 September 2026, commit `262dcab`:** see [`docs/DELIVERY-STATUS.md`](docs/DELIVERY-STATUS.md). It states what has run on real staging, what was verified only in a scratch copy, what is quarantined, and what is waiting on the operator.

## Where to read

| You want | Read |
| --- | --- |
| To use the tool | [`docs/OPERATOR-GUIDE.md`](docs/OPERATOR-GUIDE.md) |
| What has actually been verified | [`docs/DELIVERY-STATUS.md`](docs/DELIVERY-STATUS.md) |
| How it works | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| What is not covered, and release gates | [`docs/COVERAGE-AND-SECURITY.md`](docs/COVERAGE-AND-SECURITY.md) |
| The state of the credential incident | [`docs/CREDENTIAL-INCIDENT.md`](docs/CREDENTIAL-INCIDENT.md) |
| How to write Knowledge in bulk | [`server/knowledge/IMPORT_TEMPLATE.md`](server/knowledge/IMPORT_TEMPLATE.md) |

## What it does

- **Runs checks.** A login suite (five checks) on a synthetic fixture and on the staging tenants, and native Contacts, Leads and Matters checks on Fiveriverz staging. Each check has a fresh browser context, a request policy, and encrypted evidence.
- **Tells the truth about a run.** A run is `passed` only if every planned check ran and passed. Failed checks are classified (functional, infrastructure, automation, integrity, unclassified), and only a functional failure says Lawcus behaved wrongly.
- **Tracks what it creates.** Records a check creates in staging are written down and reported. Nothing is ever deleted. A read-only sweep looks for QA-named records the tool does not know about.
- **Keeps Knowledge.** Facts with a source, scope, authority and history; a dependency graph; bulk import; a change loop for product changes. Nothing is trusted until a person approves it.
- **Plans from Knowledge.** A request that names a feature is planned from approved facts and relations, with the reason for each check and what blocks the plan. Destructive requests are refused.
- **Exposes an MCP server** (22 tools) that can read, plan, run approved checks and file proposals, but cannot approve, reject, flag, resolve, dismiss or delete anything.

## Start on this Mac

Double-click `outputs/Start Lawcus QA Agent.command` in Finder (a local file kept next to the repository, not tracked by git), then keep its Terminal window open. It selects a compatible Node.js, starts the service and opens http://127.0.0.1:5173/. Node.js 24 LTS is recommended; Node >= 22.13 is required. Apple Command Line Tools build the macOS Keychain helper, and Chromium must be installed with the matching Playwright version.

Or by hand, in two terminals:

```
npm ci
npx playwright install chromium
npm run qa:service
npm run dev
```

The MCP server (for an AI client) is `npm run mcp:server`. It opens the same database and assumes the service has been started at least once, so the database and seeds exist.

First-time staging setup is in the operator guide. The service applies database updates when it starts.

## Checking the code

```
npm test              # unit and integration tests; never reads real credentials, launches a browser or touches staging
npm run test:browser  # real Chromium against the synthetic fixture; fails, not skips, if Chromium is missing
npm run test:ui       # the workspace in real Chromium against a throwaway backend; needs ports 4319 and 5173 free
npm run test:api      # a running local service
npm run lint
npm run typecheck
npm run build
npm run verify        # all of the above plus a dependency audit
```

`npm test` does **not** run the browser tests: run `test:browser` and `test:ui` too. Live staging runs are never part of any automated command.

## Boundaries

The service binds to 127.0.0.1:4319 and the fixture to 127.0.0.1:4320. Exact Host and Origin checks, a custom header and an HttpOnly SameSite cookie protect browser access. This protects against other websites, not against hostile software running under the same Mac account. Do not expose these ports.

Runbooks, results, Knowledge and audit data are in SQLite under `work/runtime/` with private permissions. The database is **not encrypted**: keep credentials and customer records out of it. Passwords, the OpenAI key and the evidence key are in macOS Keychain. Evidence is AES-256-GCM encrypted at rest; a download is a decrypted copy you control. Credential-shaped text is masked before it is stored or returned, with the limits described in the architecture document.

A CONNECT proxy pins the tenant's approved public IPv4 addresses and each browser context restricts requests before they leave the machine. That is defense in depth, not an operating-system sandbox.
