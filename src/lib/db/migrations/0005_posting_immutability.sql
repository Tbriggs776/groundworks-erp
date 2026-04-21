-- ============================================================================
-- POSTING IMMUTABILITY
-- ============================================================================
--
-- Enforces, at the database level, the invariant that once a journal is
-- `posted` it is IMMUTABLE. Corrections happen via reversing entries.
--
-- Allowed mutations on a posted journal:
--   - status: posted -> reversed (via `reverseJournal`)
--   - reversed_by_journal_id (set when the reversing entry posts)
--   - updated_at (auto)
-- Every other column is locked once posted. DELETE is blocked outright for
-- posted / reversed journals.
--
-- Same applies to gl_lines and gl_line_dimensions — you can't mutate lines
-- of a posted journal.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- gl_journals
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_posted_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed') THEN
    -- Lock these fields permanently once status reaches posted.
    IF OLD.organization_id     IS DISTINCT FROM NEW.organization_id
       OR OLD.journal_number   IS DISTINCT FROM NEW.journal_number
       OR OLD.document_no      IS DISTINCT FROM NEW.document_no
       OR OLD.journal_date     IS DISTINCT FROM NEW.journal_date
       OR OLD.period_id        IS DISTINCT FROM NEW.period_id
       OR OLD.source_code_id   IS DISTINCT FROM NEW.source_code_id
       OR OLD.source           IS DISTINCT FROM NEW.source
       OR OLD.source_document_type IS DISTINCT FROM NEW.source_document_type
       OR OLD.source_document_id   IS DISTINCT FROM NEW.source_document_id
       OR OLD.reason_code_id   IS DISTINCT FROM NEW.reason_code_id
       OR OLD.description      IS DISTINCT FROM NEW.description
       OR OLD.posted_at        IS DISTINCT FROM NEW.posted_at
       OR OLD.posted_by        IS DISTINCT FROM NEW.posted_by
       OR OLD.approved_at      IS DISTINCT FROM NEW.approved_at
       OR OLD.approved_by      IS DISTINCT FROM NEW.approved_by
       OR OLD.reverses_journal_id IS DISTINCT FROM NEW.reverses_journal_id
       OR OLD.auto_reverse_date IS DISTINCT FROM NEW.auto_reverse_date
       OR OLD.currency         IS DISTINCT FROM NEW.currency
       OR OLD.exchange_rate    IS DISTINCT FROM NEW.exchange_rate
       OR OLD.batch_id         IS DISTINCT FROM NEW.batch_id
       OR OLD.journal_template_id IS DISTINCT FROM NEW.journal_template_id
       OR OLD.recurring_journal_id IS DISTINCT FROM NEW.recurring_journal_id
       OR OLD.override_hard_close IS DISTINCT FROM NEW.override_hard_close
       OR OLD.override_reason  IS DISTINCT FROM NEW.override_reason
       OR OLD.override_approved_by IS DISTINCT FROM NEW.override_approved_by
    THEN
      RAISE EXCEPTION
        'Posted journals are immutable. Use a reversing entry to correct. (id=%, number=%)',
        OLD.id, OLD.journal_number
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Allowed status transitions from posted/reversed:
    --   posted   -> reversed  (triggered by posting a reversing entry)
    --   reversed -> reversed  (no change; sometimes happens on touch-ups)
    IF OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'reversed') THEN
      RAISE EXCEPTION
        'Cannot transition posted journal to status=%. Only posted or reversed allowed.',
        NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
      RAISE EXCEPTION
        'Cannot change status of already-reversed journal (id=%).', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_posted_journal_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'Cannot DELETE posted/reversed journal (id=%, number=%). Use a reversing entry.',
      OLD.id, OLD.journal_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS gl_journals_immutable ON public.gl_journals;
CREATE TRIGGER gl_journals_immutable
  BEFORE UPDATE ON public.gl_journals
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_posted_journal_mutation();

DROP TRIGGER IF EXISTS gl_journals_no_delete ON public.gl_journals;
CREATE TRIGGER gl_journals_no_delete
  BEFORE DELETE ON public.gl_journals
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_posted_journal_delete();


-- ---------------------------------------------------------------------------
-- gl_lines — lines of a posted/reversed journal are frozen
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_posted_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status public.journal_status;
BEGIN
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

DROP TRIGGER IF EXISTS gl_lines_immutable ON public.gl_lines;
CREATE TRIGGER gl_lines_immutable
  BEFORE UPDATE OR DELETE ON public.gl_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_posted_line_mutation();


-- ---------------------------------------------------------------------------
-- gl_line_dimensions — same story, look up through gl_lines to the journal
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_posted_line_dim_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status public.journal_status;
BEGIN
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

DROP TRIGGER IF EXISTS gl_line_dimensions_immutable ON public.gl_line_dimensions;
CREATE TRIGGER gl_line_dimensions_immutable
  BEFORE UPDATE OR DELETE ON public.gl_line_dimensions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_posted_line_dim_mutation();


-- ---------------------------------------------------------------------------
-- audit_log — full append-only enforcement
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only. UPDATE and DELETE are not permitted.'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_append_only_update ON public.audit_log;
CREATE TRIGGER audit_log_append_only_update
  BEFORE UPDATE ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_audit_mutation();

DROP TRIGGER IF EXISTS audit_log_append_only_delete ON public.audit_log;
CREATE TRIGGER audit_log_append_only_delete
  BEFORE DELETE ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_audit_mutation();
