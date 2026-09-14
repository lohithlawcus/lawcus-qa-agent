-- V5 Step 9 / sections 8 & 9 — Lawcus Knowledge Base + Behavior/Impact
-- Graph. Relational, in SQLite (section 9: "Do not install Neo4j merely
-- because this is called a graph").
--
-- knowledge_sources: retained source documents (section 8.8) a candidate
-- Knowledge item was extracted from — e.g. an official Lawcus support
-- article. Nullable reference from knowledge_items: an item verified
-- directly from this project's own implemented/tested behavior (e.g.
-- Authentication) has no external document to cite.
CREATE TABLE knowledge_sources(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  author TEXT,
  ingested_at TEXT NOT NULL
);

-- knowledge_items: atomic Knowledge records (section 8.1). Never rewritten
-- once created — a changed statement is a new version row referencing the
-- one it supersedes (section 8.3), same pattern as test_definition_versions
-- (Step 5). A row's own approval status (pending_review/approved/rejected)
-- is a separate axis from its provenance: PRODUCT_APPROVED provenance
-- describes where a fact came from (an explicit prior product decision);
-- it does not mean the Knowledge item itself skips review — nothing here
-- self-approves (section 14's discipline applied to Knowledge too).
CREATE TABLE knowledge_items(
  id TEXT PRIMARY KEY,
  semantic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN (
    'FEATURE','BUSINESS_RULE','FIELD_RULE','PERMISSION_RULE','DEPENDENCY',
    'WORKFLOW_RULE','API_CONTRACT','UI_ACTION','TEST_DATA_RULE',
    'ENVIRONMENT_RULE','KNOWN_LIMITATION','RELEASE_CHANGE',
    'INTEGRATION_RULE','VALIDATION_RULE','CALCULATION_RULE',
    'SECURITY_RULE','EDGE_CASE'
  )),
  feature_id TEXT NOT NULL REFERENCES features(id),
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  does_not_mean TEXT,
  provenance TEXT NOT NULL CHECK(provenance IN (
    'PRODUCT_APPROVED','DOCUMENTED','OBSERVED','INFERRED','ASSUMED','DEPRECATED'
  )),
  source_id TEXT REFERENCES knowledge_sources(id),
  status TEXT NOT NULL CHECK(status IN (
    'pending_review','approved','rejected','superseded','deprecated'
  )),
  supersedes TEXT REFERENCES knowledge_items(id),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  UNIQUE(semantic_id, version)
);
CREATE INDEX knowledge_items_feature_idx ON knowledge_items(feature_id, status);
CREATE INDEX knowledge_items_semantic_idx ON knowledge_items(semantic_id);

-- behavior_graph_edges: typed, versioned, approved relationships between
-- features (section 9). An unapproved (pending_review) edge exists for
-- review but must never alter a trusted impact calculation — callers doing
-- real impact analysis should filter to status='approved'.
CREATE TABLE behavior_graph_edges(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN (
    'DEPENDS_ON','USED_BY','AFFECTS','SHARED_MODEL','REQUIRES_PERMISSION',
    'BACKED_BY_API','TESTED_BY','CREATES','CONVERTS_TO','REFERENCES','TRIGGERS'
  )),
  from_feature_id TEXT NOT NULL REFERENCES features(id),
  to_feature_id TEXT NOT NULL REFERENCES features(id),
  rationale TEXT NOT NULL,
  source_id TEXT REFERENCES knowledge_sources(id),
  status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected','superseded')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  UNIQUE(type, from_feature_id, to_feature_id)
);
CREATE INDEX behavior_graph_edges_from_idx ON behavior_graph_edges(from_feature_id, status);
CREATE INDEX behavior_graph_edges_to_idx ON behavior_graph_edges(to_feature_id, status);
