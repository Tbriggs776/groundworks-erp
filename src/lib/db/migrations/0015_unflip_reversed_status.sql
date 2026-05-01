-- ============================================================================
-- UNFLIP `status='reversed'` BACK TO `status='posted'`
-- ============================================================================
--
-- Backstory: when a reversal was posted, the posting engine used to flip the
-- ORIGINAL journal's status from 'posted' to 'reversed'. That hid the
-- original's lines from every report query that filtered `status='posted'`
-- (trial balance, balance sheet, income statement, GL detail, FX revaluation,
-- dashboard) — leaving a phantom net for every voided document equal to the
-- voided amount (the reversal lines were still 'posted' and counted, but
-- the original lines weren't).
--
-- The fix in `src/lib/gl/posting.ts` is to leave the original at
-- `status='posted'`. The link to the reversing entry lives on
-- `reversed_by_journal_id`, which is what every "already reversed?" check
-- now keys off. Both entries stay 'posted' and net to zero.
--
-- This migration cleans up rows already in `status='reversed'` from the old
-- code path. Every such row is expected to have `reversed_by_journal_id` set
-- (that's invariant — the only way to land in 'reversed' was the same
-- transaction that set the link). We assert it before flipping.
--
-- The posting-immutability trigger from 0005 BLOCKS the transition
-- `reversed -> posted`, so we disable it for this transaction only.
-- ============================================================================

BEGIN;

-- Sanity: every reversed row must have a reversal link. If this fails,
-- something hand-edited the database and needs human review before flipping.
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count
    FROM public.gl_journals
   WHERE status = 'reversed' AND reversed_by_journal_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Found % gl_journals row(s) with status=''reversed'' but no reversed_by_journal_id. Aborting migration — investigate manually.',
      orphan_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$$;

-- Disable the posted-journal mutation trigger only for this transaction.
-- This is the standard data-migration escape hatch for trigger-protected
-- tables (mirrors the `app.bypass_posting_locks` pattern used for DELETEs
-- in 0007); it's scoped to this transaction only because the trigger
-- itself is restored before COMMIT.
ALTER TABLE public.gl_journals DISABLE TRIGGER gl_journals_immutable;

UPDATE public.gl_journals
   SET status = 'posted'
 WHERE status = 'reversed';

ALTER TABLE public.gl_journals ENABLE TRIGGER gl_journals_immutable;

COMMIT;
