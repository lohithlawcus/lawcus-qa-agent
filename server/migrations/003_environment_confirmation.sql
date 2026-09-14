CREATE TABLE environment_confirmations (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  facts TEXT NOT NULL CHECK(json_valid(facts)),
  created_at TEXT NOT NULL,
  UNIQUE(environment_id, version)
);
INSERT INTO environment_confirmations VALUES (
 'lawcus-staging-owner-confirmation-v1', 'lawcus', 1, 'QA product owner confirmation in project conversation',
 '{"staging":true,"dedicatedAccountAvailable":true,"mfa":false,"sso":false,"captcha":false,"credentialsConnected":false,"workerIsolationVerified":false}',
 datetime('now')
);
UPDATE environments SET name='Lawcus staging · runner not connected' WHERE id='lawcus';
