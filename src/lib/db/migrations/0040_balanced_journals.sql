-- ============================================================================
-- BALANCED JOURNALS: the database refuses an unbalanced posted entry
-- ============================================================================
-- The posting engine checks debits = credits (v7 in the journal's currency,
-- v8 in local currency) before it posts. This makes the database hold the
-- same line for any write that skips the engine:
--
--   1. A journal that is posted or reversed at commit must balance, in both
--      currencies. The check is a deferred constraint trigger, so the
--      engine's own sequence (draft, lines, then status = posted) is checked
--      once, at commit, with every line in place.
--   2. No new lines on a posted or reversed journal. Updates and deletes
--      were already refused (0005); inserts now are too.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_journal_balanced(p_journal_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  j_status public.journal_status;
  j_number text;
  dr numeric;
  cr numeric;
  dr_local numeric;
  cr_local numeric;
BEGIN
  SELECT status, journal_number INTO j_status, j_number
    FROM public.gl_journals
   WHERE id = p_journal_id;
  IF NOT FOUND OR j_status NOT IN ('posted', 'reversed') THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0),
         COALESCE(SUM(debit_local), 0), COALESCE(SUM(credit_local), 0)
    INTO dr, cr, dr_local, cr_local
    FROM public.gl_lines
   WHERE journal_id = p_journal_id;

  IF dr <> cr OR dr_local <> cr_local THEN
    RAISE EXCEPTION
      'Journal % does not balance: debits %, credits % (local: %, %). Posted journals must balance.',
      j_number, dr, cr, dr_local, cr_local
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.journal_balanced_on_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.check_journal_balanced(NEW.id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.journal_balanced_on_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.check_journal_balanced(COALESCE(NEW.journal_id, OLD.journal_id));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS gl_journals_balanced ON public.gl_journals;
CREATE CONSTRAINT TRIGGER gl_journals_balanced
  AFTER INSERT OR UPDATE OF status ON public.gl_journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_balanced_on_journal();

DROP TRIGGER IF EXISTS gl_lines_balanced ON public.gl_lines;
CREATE CONSTRAINT TRIGGER gl_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.gl_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_balanced_on_line();

-- No lines added to a posted or reversed journal.
CREATE OR REPLACE FUNCTION public.prevent_posted_line_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status public.journal_status;
BEGIN
  SELECT status INTO parent_status
    FROM public.gl_journals
   WHERE id = NEW.journal_id;
  IF parent_status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'Cannot add a line to a % journal. Use a new entry.', parent_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gl_lines_no_insert_posted ON public.gl_lines;
CREATE TRIGGER gl_lines_no_insert_posted
  BEFORE INSERT ON public.gl_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_posted_line_insert();
