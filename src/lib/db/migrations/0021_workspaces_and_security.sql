-- ============================================================================
-- WORKSPACES + SECURITY
-- ============================================================================
-- A workspace is the account a business signs up for. It holds one or more
-- companies (organizations), the people directory, invitations, and the
-- security policy. One sign-in reaches every company the person can access.
--
-- Backfill: every existing company becomes its own workspace (same id, name,
-- slug), its members become workspace members (owner → owner, admin → admin,
-- everyone else → member), pending invitations move to the workspace with a
-- grant for the original company, and audit rows get their workspace.
--
-- Also new: user_sessions (session timeouts + revocation), access_reviews
-- (SOC 2 evidence), api_rate_limits (per-key throttling).
-- ============================================================================

CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint

CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"require_mfa" boolean DEFAULT false NOT NULL,
	"session_idle_minutes" integer DEFAULT 60 NOT NULL,
	"session_max_hours" integer DEFAULT 24 NOT NULL,
	"api_key_max_days" integer,
	"allowed_email_domains" text[],
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" DEFAULT 'member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reviewed_by" uuid,
	"notes" text,
	"snapshot" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_rate_limits" (
	"api_key_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_rate_limits_api_key_id_window_start_pk" PRIMARY KEY("api_key_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aal" text DEFAULT 'aal1' NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_profiles_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_reviewed_by_profiles_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_rate_limits" ADD CONSTRAINT "api_rate_limits_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_ws_user_key" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "access_reviews_ws_idx" ON "access_reviews" USING btree ("workspace_id","completed_at");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","last_seen_at");--> statement-breakpoint

-- New columns, nullable until backfilled.
ALTER TABLE "organizations" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "workspace_role" "workspace_role" DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "grants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

INSERT INTO "workspaces" ("id", "name", "slug", "created_by", "created_at")
SELECT o."id", o."name", o."slug",
       (SELECT m."user_id" FROM "memberships" m
         WHERE m."organization_id" = o."id" AND m."role" = 'owner'
         ORDER BY m."created_at" LIMIT 1),
       o."created_at"
  FROM "organizations" o;--> statement-breakpoint

UPDATE "organizations" SET "workspace_id" = "id";--> statement-breakpoint

INSERT INTO "workspace_members" ("workspace_id", "user_id", "role", "is_active", "invited_by", "created_at")
SELECT o."workspace_id", m."user_id",
       CASE m."role" WHEN 'owner' THEN 'owner'::workspace_role
                     WHEN 'admin' THEN 'admin'::workspace_role
                     ELSE 'member'::workspace_role END,
       m."is_active", m."invited_by", m."created_at"
  FROM "memberships" m
  JOIN "organizations" o ON o."id" = m."organization_id"
 WHERE m."deleted_at" IS NULL
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;--> statement-breakpoint

UPDATE "invitations" i
   SET "workspace_id" = o."workspace_id",
       "workspace_role" = CASE i."role" WHEN 'owner' THEN 'owner'::workspace_role
                                        WHEN 'admin' THEN 'admin'::workspace_role
                                        ELSE 'member'::workspace_role END,
       "grants" = jsonb_build_array(jsonb_build_object('organizationId', i."organization_id", 'role', i."role"))
  FROM "organizations" o
 WHERE o."id" = i."organization_id";--> statement-breakpoint

-- audit_log is append-only (UPDATE trigger from 0005). This one-time
-- backfill only adds the workspace id; the trigger is back on right after.
ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_append_only_update";--> statement-breakpoint
UPDATE "audit_log" a SET "workspace_id" = o."workspace_id"
  FROM "organizations" o WHERE o."id" = a."organization_id";--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_append_only_update";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tighten
-- ---------------------------------------------------------------------------

ALTER TABLE "organizations" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizations_workspace_idx" ON "organizations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invitations_ws_email_idx" ON "invitations" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "audit_log_ws_time_idx" ON "audit_log" USING btree ("workspace_id","occurred_at");--> statement-breakpoint

-- The old RLS policy reads invitations.organization_id; drop it first.
DROP POLICY IF EXISTS "invitations_select_org_or_self" ON "invitations";--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_organization_id_organizations_id_fk";--> statement-breakpoint
DROP INDEX "invitations_org_email_idx";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "role";--> statement-breakpoint

-- Callers pass organization_id (company events) or workspace_id (workspace
-- events); fill the workspace from the company so both are queryable.
CREATE OR REPLACE FUNCTION public.audit_log_fill_workspace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.workspace_id IS NULL AND NEW.organization_id IS NOT NULL THEN
    SELECT workspace_id INTO NEW.workspace_id
      FROM public.organizations WHERE id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.audit_log_fill_workspace() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE TRIGGER audit_log_fill_workspace
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_fill_workspace();--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_required" CHECK ("audit_log"."workspace_id" IS NOT NULL);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS (see 0019 for the overall shape)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_workspace_member(ws_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
     WHERE user_id = auth.uid() AND workspace_id = ws_id
       AND is_active = TRUE AND deleted_at IS NULL
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.is_workspace_admin(ws_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
     WHERE user_id = auth.uid() AND workspace_id = ws_id
       AND role IN ('owner', 'admin')
       AND is_active = TRUE AND deleted_at IS NULL
  );
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.is_workspace_member(uuid) FROM PUBLIC, anon;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.is_workspace_admin(uuid) FROM PUBLIC, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(uuid) TO authenticated;--> statement-breakpoint

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Server-only, no policies: session rows and rate-limit counters.
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "workspaces_select_member" ON "workspaces" FOR SELECT TO authenticated
  USING (public.is_workspace_member(id));--> statement-breakpoint
CREATE POLICY "workspace_members_select_member" ON "workspace_members" FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_workspace_member(workspace_id));--> statement-breakpoint
CREATE POLICY "access_reviews_select_admin" ON "access_reviews" FOR SELECT TO authenticated
  USING (public.is_workspace_admin(workspace_id));--> statement-breakpoint
CREATE POLICY "invitations_select_admin_or_self" ON "invitations" FOR SELECT TO authenticated
  USING (
    public.is_workspace_admin(workspace_id)
    OR lower(email) = lower((SELECT email FROM auth.users WHERE id = auth.uid()))
  );--> statement-breakpoint

-- Workspace-level audit rows (no company) are for workspace admins.
CREATE POLICY "audit_log_select_workspace_admin" ON "audit_log" FOR SELECT TO authenticated
  USING (organization_id IS NULL AND public.is_workspace_admin(workspace_id));--> statement-breakpoint

-- Workspace admins see every company in their workspace.
DROP POLICY IF EXISTS "organizations_select_own" ON "organizations";--> statement-breakpoint
CREATE POLICY "organizations_select_own" ON "organizations" FOR SELECT TO authenticated
  USING (public.is_member_of(id) OR public.is_workspace_admin(workspace_id));--> statement-breakpoint

-- Teammates now means "shares a workspace".
DROP POLICY IF EXISTS "profiles_select_self_or_teammates" ON "profiles";--> statement-breakpoint
CREATE POLICY "profiles_select_self_or_teammates" ON "profiles" FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1
        FROM public.workspace_members mine
        JOIN public.workspace_members theirs USING (workspace_id)
       WHERE mine.user_id = auth.uid() AND mine.is_active = TRUE
         AND theirs.user_id = public.profiles.id AND theirs.is_active = TRUE
    )
  );
