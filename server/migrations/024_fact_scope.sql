-- KB-03: a fact that holds only for some roles / configurations / tenants /
-- environments says so here, as a small strict JSON object (keys: roles,
-- configurations, tenants, environments; each a list of names). NULL means the
-- fact applies everywhere. (applies_to is unrelated: it names the kinds of
-- record a fact is about, e.g. "contact".)
ALTER TABLE knowledge_items ADD COLUMN scope TEXT CHECK(scope IS NULL OR json_valid(scope));
