-- ============================================================================
-- TENANT GUARDS: hard walls between companies, in the database
-- ============================================================================
-- Every company table carries organization_id, and services filter by it.
-- This makes the database refuse what the code should never do:
--
--   * a row that points at another company's row (an invoice line on
--     another company's account, a journal line tagged with another
--     company's customer, ...), whichever code path writes it
--   * moving a row to another company (organization_id never changes)
--
-- install_tenant_guard(table) reads the table's foreign keys from the
-- catalog and (re)builds a BEFORE INSERT / UPDATE trigger that checks each
-- reference belongs to the same company. Call it for every new company
-- table; scripts/test-isolation.ts fails when a reference is unguarded.
-- Violations raise 23503 with a "tenant_guard:" message, which the app
-- reports as "not found" (foreign ids are never confirmed to exist).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.install_tenant_guard(target regclass)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $install$
DECLARE
  tbl text;
  fn text;
  checks text := '';
  cols text := 'organization_id';
  r record;
BEGIN
  SELECT relname INTO tbl FROM pg_class WHERE oid = target;
  fn := 'tenant_guard_' || tbl;

  FOR r IN
    SELECT col, ref, ref_has_global FROM (
      -- Real foreign keys to other company tables.
      SELECT a.attname::text AS col,
             dst.relname::text AS ref,
             NOT o.attnotnull AS ref_has_global
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        JOIN pg_class dst ON dst.oid = c.confrelid
        JOIN pg_attribute o ON o.attrelid = c.confrelid AND o.attname = 'organization_id' AND NOT o.attisdropped
       WHERE c.conrelid = target
         AND c.contype = 'f'
         AND array_length(c.conkey, 1) = 1
         AND a.attname <> 'organization_id'
      UNION
      -- Report tags kept without a foreign key.
      SELECT v.col, v.ref, false
        FROM (VALUES ('gl_lines', 'customer_id', 'customers'),
                     ('gl_lines', 'vendor_id', 'vendors')) AS v(t, col, ref)
       WHERE v.t = tbl
    ) refs
    ORDER BY col
  LOOP
    cols := cols || format(', %I', r.col);
    checks := checks || format(
      $c$
  IF NEW.%1$I IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.%2$I x
     WHERE x.id = NEW.%1$I
       AND (x.organization_id IS NOT DISTINCT FROM NEW.organization_id%3$s)
  ) THEN
    RAISE EXCEPTION 'tenant_guard: %2$s record not found in this company (%4$s.%1$s)' USING ERRCODE = '23503';
  END IF;$c$,
      r.col, r.ref, CASE WHEN r.ref_has_global THEN ' OR x.organization_id IS NULL' ELSE '' END, tbl);
  END LOOP;

  EXECUTE format(
    $f$
CREATE OR REPLACE FUNCTION public.%1$I() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $body$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'tenant_guard: a row cannot move to another company (%2$s)' USING ERRCODE = '23503';
  END IF;%3$s
  RETURN NEW;
END
$body$$f$,
    fn, tbl, checks);

  EXECUTE format('DROP TRIGGER IF EXISTS tenant_guard ON public.%I', tbl);
  EXECUTE format(
    'CREATE TRIGGER tenant_guard BEFORE INSERT OR UPDATE OF %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',
    cols, tbl, fn);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', fn);
END
$install$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.install_tenant_guard(regclass) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- Every company table, today.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
  LOOP
    PERFORM public.install_tenant_guard(t);
  END LOOP;
END
$$;
