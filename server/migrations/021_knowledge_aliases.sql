-- A readable semantic_id is a label, not an identity: knowledge_items.id is the
-- immutable identity. When a fact is proposed again under a different label
-- (a rename, a re-import) the new label is recorded here as an alias of the
-- existing item instead of creating a duplicate.
CREATE TABLE knowledge_item_aliases(
  alias_semantic_id TEXT PRIMARY KEY,
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX knowledge_item_aliases_item ON knowledge_item_aliases(knowledge_item_id);
