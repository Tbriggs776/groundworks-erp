CREATE TYPE "public"."email_document_type" AS ENUM('invoice', 'estimate', 'sales_receipt', 'credit_memo', 'purchase_order', 'statement');--> statement-breakpoint
CREATE TYPE "public"."email_kind" AS ENUM('document', 'reminder');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('sent', 'failed', 'delivered', 'delayed', 'bounced', 'complained');--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_type" "email_document_type" NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "email_kind" DEFAULT 'document' NOT NULL,
	"reminder_offset" integer,
	"party_id" uuid,
	"to" text[] NOT NULL,
	"cc" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"attachment_name" text,
	"status" "email_status" NOT NULL,
	"provider_id" text,
	"error" text,
	"sent_by" uuid,
	"sent_by_agent_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"bounced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reply_to" text,
	"copy_to" text,
	"reminders_enabled" boolean DEFAULT false NOT NULL,
	"reminder_days" integer[] DEFAULT '{-3,0,7,30}'::integer[] NOT NULL,
	"templates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_sent_by_profiles_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_sent_by_agent_id_agents_id_fk" FOREIGN KEY ("sent_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_document_idx" ON "email_messages" USING btree ("organization_id","document_type","document_id");--> statement-breakpoint
CREATE INDEX "email_messages_org_sent_idx" ON "email_messages" USING btree ("organization_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_provider_key" ON "email_messages" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_settings_org_key" ON "email_settings" USING btree ("organization_id");--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "email_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "email_messages_select_member" ON "email_messages" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "email_settings_select_member" ON "email_settings" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022).
SELECT public.install_tenant_guard('public.email_messages');--> statement-breakpoint
SELECT public.install_tenant_guard('public.email_settings');
