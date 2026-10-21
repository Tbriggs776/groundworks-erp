CREATE TYPE "public"."qbo_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."qbo_import_status" AS ENUM('running', 'failed', 'done');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'conversion';--> statement-breakpoint
CREATE TABLE "qbo_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"realm_id" text NOT NULL,
	"environment" "qbo_environment" NOT NULL,
	"company_name" text,
	"access_token" text,
	"refresh_token" text,
	"access_expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qbo_id_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"qbo_id" text NOT NULL,
	"local_id" uuid,
	"value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "qbo_import_status" DEFAULT 'running' NOT NULL,
	"cursor" jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"batches" integer DEFAULT 0 NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "qbo_connections" ADD CONSTRAINT "qbo_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_connections" ADD CONSTRAINT "qbo_connections_connected_by_profiles_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_id_map" ADD CONSTRAINT "qbo_id_map_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_imports" ADD CONSTRAINT "qbo_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_imports" ADD CONSTRAINT "qbo_imports_started_by_profiles_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_connections_org_key" ON "qbo_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_id_map_key" ON "qbo_id_map" USING btree ("organization_id","entity","qbo_id");--> statement-breakpoint
CREATE INDEX "qbo_imports_org_idx" ON "qbo_imports" USING btree ("organization_id");--> statement-breakpoint

-- Row level security. qbo_connections holds sealed OAuth tokens: no policy
-- at all, so nothing reads it through the REST API. Members can read the
-- import's progress and the id map.
ALTER TABLE "qbo_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qbo_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qbo_id_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qbo_imports_select_member" ON "qbo_imports" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "qbo_id_map_select_member" ON "qbo_id_map" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022).
SELECT public.install_tenant_guard('public.qbo_connections');--> statement-breakpoint
SELECT public.install_tenant_guard('public.qbo_imports');--> statement-breakpoint
SELECT public.install_tenant_guard('public.qbo_id_map');
