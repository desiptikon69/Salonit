-- Keep historical aggregates intact; new accruals identify the exact service item.
ALTER TABLE accruals ADD COLUMN IF NOT EXISTS item_id text;
ALTER TABLE accruals DROP CONSTRAINT IF EXISTS accruals_visit_id_staff_id_service_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS accruals_visit_item_unique ON accruals(visit_id,item_id) WHERE item_id IS NOT NULL;
