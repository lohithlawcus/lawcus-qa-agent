-- KB-05: product-change loop. A change signal is something a human hands the
-- agent ("the Contact form now requires X", a release note, a ticket). It is
-- recorded with its source and time, analysed against approved Knowledge, and
-- can produce PENDING revisions and review flags. Nothing here changes an
-- approved fact, a test, or a pass/fail expectation by itself.
CREATE TABLE change_signals(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('qa_note','requirement','design','api_spec','release_note','code_change','observed_diff')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  source_ref TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('new','analyzed','dismissed')),
  analysis TEXT CHECK(analysis IS NULL OR json_valid(analysis)),
  analyzed_at TEXT,
  dismissed_by TEXT,
  dismissed_at TEXT,
  dismissal_note TEXT
);
CREATE TABLE change_signal_items(
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES change_signals(id),
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
  relation TEXT NOT NULL CHECK(relation IN ('proposes')),
  created_at TEXT NOT NULL,
  UNIQUE(signal_id, knowledge_item_id, relation)
);
CREATE TABLE knowledge_review_flags(
  id TEXT PRIMARY KEY,
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
  signal_id TEXT NOT NULL REFERENCES change_signals(id),
  note TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  resolution TEXT CHECK(resolution IS NULL OR resolution IN ('still_valid','revised','obsolete')),
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  UNIQUE(knowledge_item_id, signal_id)
);
CREATE INDEX knowledge_review_flags_open ON knowledge_review_flags(status, knowledge_item_id);
