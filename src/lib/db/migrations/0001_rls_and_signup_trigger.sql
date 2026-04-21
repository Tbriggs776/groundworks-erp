-- ============================================================================
-- RLS + SIGNUP TRIGGER
-- ============================================================================
--
-- Design notes:
--
-- 1. SIGNUP TRIGGER
--    Supabase Auth creates rows in auth.users. We mirror a minimal profile
--    into public.profiles so the rest of the app only has to know about
--    the public schema. ON CONFLICT DO NOTHING is defensive.
--
-- 2. RLS STRATEGY
--    App-layer writes go through Drizzle via DATABASE_URL, which connects
--    as the `postgres` superuser and BYPASSES RLS. So RLS here is a *safety
--    net* for anything that ever touches the DB via supabase-js (Realtime,
--    client-side queries, Studio access for non-admins).
--
--    Tenant-scoped SELECT policies now; write policies can follow when
--    writes are exposed through supabase-js.
--
-- 3. HELPER FUNCTION
--    public.is_member_of(org_id) is SECURITY DEFINER so it can read
--    memberships without recursing into RLS. search_path is pinned to
--    prevent schema-injection attacks against a definer-privileged function.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Signup trigger: auth.users INSERT -> public.profiles
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- Keep profiles.email in sync if the user changes their email in Supabase.
CREATE OR REPLACE FUNCTION public.handle_user_email_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles
       SET email = NEW.email,
           updated_at = now()
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_user_email_change();


-- ---------------------------------------------------------------------------
-- RLS helper: is the current user an active member of the given org?
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_member_of(org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.memberships
     WHERE user_id = auth.uid()
       AND organization_id = org_id
       AND is_active = TRUE
       AND deleted_at IS NULL
  );
$$;


-- ---------------------------------------------------------------------------
-- Backfill profiles for any users that already exist in auth.users.
-- Idempotent via ON CONFLICT.
-- ---------------------------------------------------------------------------

INSERT INTO public.profiles (id, email, full_name, avatar_url)
SELECT id, email,
       raw_user_meta_data ->> 'full_name',
       raw_user_meta_data ->> 'avatar_url'
  FROM auth.users
ON CONFLICT (id) DO NOTHING;


-- ---------------------------------------------------------------------------
-- Enable RLS + SELECT policies
-- ---------------------------------------------------------------------------

-- ORGANIZATIONS: see orgs you're a member of.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organizations_select_own" ON public.organizations;
CREATE POLICY "organizations_select_own"
  ON public.organizations
  FOR SELECT
  TO authenticated
  USING (public.is_member_of(id));


-- PROFILES: see your own profile + profiles of anyone sharing an org.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_self_or_teammates" ON public.profiles;
CREATE POLICY "profiles_select_self_or_teammates"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1
        FROM public.memberships mine
        JOIN public.memberships theirs USING (organization_id)
       WHERE mine.user_id = auth.uid()
         AND mine.is_active = TRUE
         AND theirs.user_id = public.profiles.id
         AND theirs.is_active = TRUE
    )
  );

DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;
CREATE POLICY "profiles_update_self"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());


-- MEMBERSHIPS: see memberships for orgs you belong to.
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "memberships_select_same_org" ON public.memberships;
CREATE POLICY "memberships_select_same_org"
  ON public.memberships
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_member_of(organization_id));


-- INVITATIONS: see invites for orgs you belong to, or invites sent to your email.
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invitations_select_org_or_self" ON public.invitations;
CREATE POLICY "invitations_select_org_or_self"
  ON public.invitations
  FOR SELECT
  TO authenticated
  USING (
    public.is_member_of(organization_id)
    OR LOWER(email) = LOWER((
      SELECT email FROM auth.users WHERE id = auth.uid()
    ))
  );


-- AUDIT LOG: see audit rows for orgs you belong to. No UPDATE / DELETE policies
-- by design; writes come in via Drizzle (append-only server-side).
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_select_own_org" ON public.audit_log;
CREATE POLICY "audit_log_select_own_org"
  ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (public.is_member_of(organization_id));


GRANT EXECUTE ON FUNCTION public.is_member_of(uuid) TO authenticated;
