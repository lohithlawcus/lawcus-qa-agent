# Operator guide

**As of 26 September 2026, commit `262dcab`.** For the person who uses the tool. No programming needed.

## What this tool is, and is not

It runs checks against the Lawcus staging site in a real browser, keeps the evidence, and helps you keep a list of what Lawcus is supposed to do (its "Knowledge"). It **never approves anything itself**, never changes what a check expects, and does not delete anything in Lawcus on its own. Any future deletion needs your named approval for each record; that path is designed but not yet available. Every decision that matters is yours.

It is one Mac, one dedicated test account, one run at a time. It is not complete coverage of Lawcus. `DELIVERY-STATUS.md` says exactly what has been verified.

## Setting up staging safely (first time)

1. Open the **Environment** tab.
2. Choose **Sign in and save verified account**. A separate browser window opens: sign in yourself with the dedicated test account, then open the profile menu. The tool confirms it is the right account before saving anything to the macOS Keychain. Never type this password anywhere else in the tool.
3. Choose **Check browser connection**. This only proves the test browser can start.
4. Do not use your own personal account for tests. Use only the dedicated QA account.

## The tabs

| Tab | What it is for |
| --- | --- |
| Test | Ask for a test in plain words, review the plan, run it. |
| TestBook | Every check the tool knows, by feature, with its history. |
| AI Usage | Every AI call, and the switch that turns AI use off. |
| Run history | Every run and its evidence. Also where records left in staging are listed. |
| Proposals | Changes the tool suggests (a new test, a locator change). Nothing applies until you approve it. |
| Knowledge | Facts waiting for your approval, and the import box. |
| Facts & changes | Every fact with its evidence, and the place to record a product change. |
| API Contracts | What a Lawcus request should look like. You approve each one. |
| Personas | Extra test accounts, verified by a real sign-in. |
| Teach / Record | Show the tool a workflow once; it becomes a proposal, never an automatic test. |
| Safety & coverage | Which checks count as coverage today and why the others do not, a quality baseline, and what the tool guards against. |
| Environment | Accounts, the browser check, and the staging sweep. |

## Running a test

1. In **Test**, pick the environment (Fiveriverz is the main staging tenant) and describe what you want, or use **Use standard login checks**.
2. **Build plan.** The plan is a proposal. It lists each check and, for plans built from Knowledge, why each was chosen and what must be set up first.
3. Read it. If it says **CANNOT RUN YET**, it lists what is missing and the run button stays off. If it shows **Needs your review**, a relationship between features is waiting for your approval and was **not** used.
4. Run it. Runs are limited to **three sign-ins per ten minutes** because the shared test account has stalled after bursts. Wait if you hit the limit; do not keep retrying.

A request that asks to delete or remove something is refused and explained. The tool only plans tests.

## Reading a result

A run ends with one of these outcomes.

| Outcome | Meaning |
| --- | --- |
| `passed` | Every planned check ran and passed. |
| `failed` | At least one check showed Lawcus behaving differently than expected. |
| `inconclusive` | Nothing showed Lawcus behaving wrongly, but at least one check could not complete, or nothing ran. **This is not a pass.** |
| `partial` | Everything that ran passed, but some planned checks did not run. **This is not a pass.** |
| `cancelled` | You stopped the run. |

Each check that did not pass also says what kind of problem it was.

| Kind | Meaning | What to do |
| --- | --- | --- |
| `functional` | The check ran and Lawcus did not do what was expected. | Look at the evidence. It may be a real defect, or an intentional change: you decide. |
| `infrastructure` | The environment or tooling stopped the check: sign-in never completed, no browser, network or staging unavailable. | This says nothing about Lawcus. Wait, then try once. |
| `automation` | The check could not drive the page: an element was missing or ambiguous, or a request was blocked by the tool's own safety rules. | The page may have changed or the check needs repair. It does not show Lawcus is wrong. |
| `integrity` | Something the tool keeps could not be saved, such as the evidence. | The check is not counted as passed. Fix the storage problem and rerun. |
| `unclassified` | An error the tool does not recognise. | Needs a look. Nothing is concluded about Lawcus. |

The technical reason code is shown next to the explanation.

## Evidence

Open a run in **Run history** to see its results, screenshots and traces. Screenshots hide password fields. Downloading evidence makes a decrypted copy that you control. A check whose evidence **could not be saved** is not counted as passed and is marked as an integrity problem.

## Records left in Lawcus

Some checks create records in Lawcus (a contact, a lead, a matter). The tool writes each one down as soon as it exists. It **does not delete them on its own**; deleting one is a decision for you, and the approval path that would allow it is designed but not yet available.

- In **Run history**, **Records left in staging** lists what runs created and Lawcus still holds. Remove a record in Lawcus yourself, then press **Mark as removed in Lawcus**. That only records what you did and never deletes anything. Or press **Keep it** if it should stay. To have the tool delete a record, approve it in **Records the tool created** and use **Delete one approved record**.
- If a create was clicked but never confirmed, a "may exist" entry tells you what name to search for.

**The staging sweep** (Environment tab, **Sweep now**) reads the tenant's Contacts, Matters and Leads lists and shows records whose names match this tool's naming (`QA Agent …`, `QA Matter …`, `QAFieldTest…`, `QA Batch …`, `QA impacted-test …`) that the tool has no record of. It changes nothing and copies nobody else's records. A matching name is only a **candidate**: mark each one **Ours**, **Not ours** or **Leave in place**. It sees open matters only.

## Teaching the tool a rule

1. In **Knowledge**, paste rules into the import box (**Load example** shows the format; the full format is in `server/knowledge/IMPORT_TEMPLATE.md`). Every fact needs a **Source Title**. Add a `Scope:` line (for example `Scope: roles=owner,admin; environments=lawcus`) only for a fact that holds for some roles, configurations, tenants or environments; leave it out for a fact that applies everywhere. One mistake refuses the whole import and names the line.
2. Imported facts wait as **pending review**. Read each one, add a note if you like, and **Approve** or **Reject**.
3. If approving would replace a documented fact with weaker evidence (observed, inferred or assumed), the tool stops and asks you to write why. Only then can you approve anyway.
4. In **Facts & changes → Facts**, open any fact to see who approved it, its source, where it applies, which tests assert it and its history.

Relationships between features ("Matters depend on Contacts") are proposed the same way and used in plans only after you approve them.

## Flagging a product change

When Lawcus changes (a release note, a requirement, something a tester noticed):

1. Open **Facts & changes → Product changes**, choose the kind, write a title and what changed, and press **Record and analyze**. Passwords and tokens pasted here are masked.
2. The tool shows the facts the change may touch and the checks worth re-running, each with its reason, and what is missing.
3. For any fact you can **Propose a revision** (it waits for your approval like any fact), **Flag for re-review** (a reminder; the fact stays approved), or resolve a flag as still valid, revised or obsolete.

Nothing here changes a fact or a test by itself.

## Showing the tool a workflow

1. In **Teach / Record**, choose the environment, name the feature and describe what you'll do, then press **Start recording**. A separate, visible Chromium window opens, signed in — perform the workflow there yourself.
2. A small round button floats in that window. It starts as **○ Start teaching**: nothing you do yet is kept. Click it right before the steps you actually want taught — it turns into a red dot, and expands to **● Teaching ON — click to stop** when you hover over it. Click it again when you're done with those steps; you can turn it on and off as many times as you like in one session.
3. Drag the button anywhere if it's sitting on top of something you need to click. It stays where you put it for the rest of the session.
4. Come back here and press **Finish & create proposals**. Only what you did while the marker was on becomes a proposal — `NEW_PRIMITIVE` for anything not already automated, `TESTABILITY_HOOK_REQUEST` for an element with no stable locator. Review them like any other proposal; nothing here is ever trusted or run automatically.

A recording session is not restricted the way a real check is: it can reach anything Lawcus itself would load, because you are the one driving it, exactly as you could in an ordinary browser. That trust does not extend past the session — what comes out is still only ever a proposal.

## Only you can

Approve a fact or a relationship, approve an API contract, decide whether a change is intentional, confirm a password rotation, and decide whether the tool may ever delete staging records. The tool and its MCP interface can only propose.

## If something looks wrong

- **Sign-in stalls or times out:** stop and wait before trying again; repeated attempts have not helped. In this project stalls cleared after some tens of minutes, but the cause is not confirmed.
- **A run will not start and says "no staging sign-in was used":** the tool found something missing before it spent a sign-in (the evidence key, the evidence folder, the browser, or the network). Fix what it names and start again; nothing was used from your ten-minute allowance.
- **A run says `inconclusive`:** read the kind above: it is usually the environment, not Lawcus.
- **Something these docs mention is missing** (for example the Matters feature, or a newer screen's data): restart the service. It applies database updates when it starts.
- **Anything about credentials:** see `CREDENTIAL-INCIDENT.md`.
