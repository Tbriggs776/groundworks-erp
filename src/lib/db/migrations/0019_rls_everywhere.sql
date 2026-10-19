-- ============================================================================
-- RLS EVERYWHERE
-- ============================================================================
-- Until now only organizations / profiles / memberships / invitations /
-- audit_log had row-level security. Every other public table was reachable
-- through Supabase's auto-generated REST API (PostgREST) by anyone holding
-- the anon key — which ships to every browser. The Supabase security
-- advisor reports this as `rls_disabled_in_public` (level ERROR).
--
-- App code is unaffected: Drizzle connects as the table owner (`postgres`),
-- and owners bypass RLS unless FORCE ROW LEVEL SECURITY is set.
--
-- Policy shape:
--   * tables with organization_id  → members of that org may SELECT
--   * currencies (global reference) → any signed-in user may SELECT
--   * api_keys, idempotency_keys    → no policies at all: secret hashes and
--                                     cached responses are server-only
--   * no INSERT / UPDATE / DELETE policies anywhere — writes go through the
--     server, which enforces roles, scopes, and the audit trail
--
-- The loop is idempotent and also covers any table a later migration
-- forgets; scripts/test-rls.ts fails CI if a public table lacks RLS.
-- ============================================================================

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname AS name
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.name);
  END LOOP;

  FOR t IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
       AND c.relname NOT IN (
         'api_keys', 'idempotency_keys',
         -- these already carry hand-written policies from 0001
         'memberships', 'invitations', 'audit_log'
       )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.name || '_select_member', t.name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_member_of(organization_id))',
      t.name || '_select_member', t.name
    );
  END LOOP;
END $$;
--> statement-breakpoint

DROP POLICY IF EXISTS "currencies_select_authenticated" ON public.currencies;
--> statement-breakpoint
CREATE POLICY "currencies_select_authenticated"
  ON public.currencies FOR SELECT TO authenticated USING (true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Function hardening (advisor: function_search_path_mutable,
-- anon_security_definer_function_executable)
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.prevent_posted_journal_mutation() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.prevent_posted_journal_delete() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.prevent_posted_line_mutation() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.prevent_posted_line_dim_mutation() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.prevent_audit_mutation() SET search_path = public, pg_temp;
--> statement-breakpoint

-- Trigger functions are never meant to be called over RPC.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.handle_user_email_change() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- Policies evaluate is_member_of() as the querying role, so `authenticated`
-- keeps EXECUTE; anonymous callers have no business probing memberships.
REVOKE EXECUTE ON FUNCTION public.is_member_of(uuid) FROM PUBLIC, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_member_of(uuid) TO authenticated;
