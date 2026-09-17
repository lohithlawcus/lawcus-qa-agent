-- V5 "add two more urls" (2026-09-17) — Fiveriverz was the only real
-- staging tenant this project has ever targeted; the operator now has
-- three more Lawcus deployments they want independently selectable.
-- Same real-confirmation discipline as migration 003's original
-- lawcus-staging-owner-confirmation-v1: these facts are the operator's
-- own words in conversation on this date, not assumed or copied blindly.

INSERT INTO environments VALUES ('co-server', 'Co Server', 'https://lohith.lawcus.co', 'unverified', 0);
INSERT INTO environments VALUES ('prod-usa', 'Prod USA', 'https://lohith.lawcus.com', 'unverified', 0);
INSERT INTO environments VALUES ('prod-eu', 'Prod EU', 'https://lohith.eu.lawcus.com', 'unverified', 0);

INSERT INTO environment_confirmations VALUES (
 'co-server-owner-confirmation-v1', 'co-server', 1, 'QA product owner confirmation in project conversation',
 '{"staging":true,"dedicatedAccountAvailable":true,"mfa":false,"sso":false,"captcha":false,"credentialsConnected":false,"workerIsolationVerified":false}',
 datetime('now')
);
INSERT INTO environment_confirmations VALUES (
 'prod-usa-owner-confirmation-v1', 'prod-usa', 1, 'QA product owner confirmation in project conversation',
 '{"staging":true,"dedicatedAccountAvailable":true,"mfa":false,"sso":false,"captcha":false,"credentialsConnected":false,"workerIsolationVerified":false}',
 datetime('now')
);
INSERT INTO environment_confirmations VALUES (
 'prod-eu-owner-confirmation-v1', 'prod-eu', 1, 'QA product owner confirmation in project conversation',
 '{"staging":true,"dedicatedAccountAvailable":true,"mfa":false,"sso":false,"captcha":false,"credentialsConnected":false,"workerIsolationVerified":false}',
 datetime('now')
);

-- Renamed, not re-identified: id stays 'lawcus' everywhere (runbooks,
-- runs, every hardcoded environment_id==='lawcus' check in the codebase)
-- — only the human-facing label changes.
UPDATE environments SET name='Fiveriverz' WHERE id='lawcus';
