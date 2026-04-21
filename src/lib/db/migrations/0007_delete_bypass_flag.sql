-- ============================================================================
-- DELETE BYPASS FLAG
-- ============================================================================
--
-- The posted-journal DELETE triggers from 0005 block cascade deletes when an
-- organization is wound down. We want to keep the tamper-protection
-- (UPDATE stays strict, unchanged), but allow EXPLICIT teardown via a
-- session-level bypass flag.
--
-- Usage (test cleanup, admin off-hours ops):
--
--   BEGIN;
--     SET LOCAL app.bypass_posting_locks = 'true';
--     DELETE FROM organizations WHERE slug LIKE 'gl-test-%';
--   COMMIT;
--
-- Scoped to the transaction (`SET LOCAL`) so it doesn't leak. Normal
-- application code never sets it.
--
-- SECURITY NOTE: convenience, not defense. An actor with DB-level write
-- access could set the flag or drop the trigger entirely. The strong
-- guarantee is UPDATE immutability — posted journals and audit rows cannot
-- be silently TAMPERED WITH, which is the harder and more damaging attack.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prevent_posted_journal_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.bypass_posting_locks', true) = 'true' THEN
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'Cannot DELETE posted/reversed journal (id=%, number=%). Use a reversing entry.',
      OLD.id, OLD.journal_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_posted_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status public.journal_status;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.bypass_posting_locks', true) = 'true' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    SELECT status INTO parent_status
      FROM public.gl_journals
     WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
    IF parent_status IN ('posted', 'reversed') THEN
      RAISE EXCEPTION
        'Cannot % a gl_lines row whose journal is %.',
        lower(TG_OP), parent_status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_posted_line_dim_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status public.journal_status;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.bypass_posting_locks', true) = 'true' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    SELECT j.status INTO parent_status
      FROM public.gl_lines l
      JOIN public.gl_journals j ON j.id = l.journal_id
     WHERE l.id = COALESCE(NEW.line_id, OLD.line_id);
    IF parent_status IN ('posted', 'reversed') THEN
      RAISE EXCEPTION
        'Cannot % a gl_line_dimensions row whose journal is %.',
        lower(TG_OP), parent_status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
