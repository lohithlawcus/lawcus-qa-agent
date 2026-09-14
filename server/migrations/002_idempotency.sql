ALTER TABLE runs ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX run_request_key ON runs(request_key) WHERE request_key IS NOT NULL;
