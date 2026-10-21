CREATE TYPE "public"."bank_feed_status" AS ENUM('active', 'login_required', 'disconnected');--> statement-breakpoint
ALTER TYPE "public"."statement_format" ADD VALUE 'feed';--> statement-breakpoint
CREATE TABLE "bank_feed_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text,
	"subtype" text,
	"account_id" uuid,
	"start_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_feed_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'plaid' NOT NULL,
	"item_id" text NOT NULL,
	"institution_id" text,
	"institution_name" text,
	"access_token" text,
	"cursor" text,
	"status" "bank_feed_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_connection_id_bank_feed_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_feed_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_connections" ADD CONSTRAINT "bank_feed_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_connections" ADD CONSTRAINT "bank_feed_connections_connected_by_profiles_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_accounts_key" ON "bank_feed_accounts" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "bank_feed_accounts_account_idx" ON "bank_feed_accounts" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_connections_item_key" ON "bank_feed_connections" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "bank_feed_connections_org_idx" ON "bank_feed_connections" USING btree ("organization_id");--> statement-breakpoint

-- Row level security. bank_feed_connections holds sealed bank access
-- tokens: no policy at all. Members can read the feed accounts.
ALTER TABLE "bank_feed_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bank_feed_accounts_select_member" ON "bank_feed_accounts" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022).
SELECT public.install_tenant_guard('public.bank_feed_connections');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_feed_accounts');
