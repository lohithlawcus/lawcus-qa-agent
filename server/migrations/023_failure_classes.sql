-- Why a check did not pass, in a form a person and a rollup can use: which
-- kind of failure it was (functional / infrastructure / automation / integrity /
-- unclassified) and a stable reason code. NULL for passed checks and for results
-- recorded before classification existed (those are read as functional).
ALTER TABLE scenario_results ADD COLUMN failure_class TEXT
  CHECK(failure_class IS NULL OR failure_class IN ('functional','infrastructure','automation','integrity','unclassified'));
ALTER TABLE scenario_results ADD COLUMN reason_code TEXT;
