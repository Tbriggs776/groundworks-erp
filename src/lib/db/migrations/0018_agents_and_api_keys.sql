CREATE TYPE "public"."agent_autonomy" AS ENUM('read', 'draft', 'post');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_channel" AS ENUM('ui', 'api', 'mcp', 'system');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role" "membership_role" DEFAULT 'bookkeeper' NOT NULL,
	"autonomy" "agent_autonomy" DEFAULT 'draft' NOT NULL,
	"max_post_amount" numeric(20, 4),
	"created_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agents_role_not_admin" CHECK ("agents"."role" NOT IN ('owner', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY['read']::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "api_keys_one_principal" CHECK (("api_keys"."agent_id" IS NULL) <> ("api_keys"."user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_type" "audit_actor_type";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "channel" "audit_channel";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_name_key" ON "agents" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_keys_agent_idx" ON "api_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_org_key" ON "idempotency_keys" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_agent_idx" ON "audit_log" USING btree ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "gl_journals_agent_idx" ON "gl_journals" USING btree ("organization_id","created_by_agent_id");--> statement-breakpoint
CREATE INDEX "ap_bills_agent_idx" ON "ap_bills" USING btree ("organization_id","created_by_agent_id");