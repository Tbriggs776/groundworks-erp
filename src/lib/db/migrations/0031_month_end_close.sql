CREATE TABLE "close_task_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "close_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "first_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "close_note" text;--> statement-breakpoint
ALTER TABLE "close_task_completions" ADD CONSTRAINT "close_task_completions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_task_completions" ADD CONSTRAINT "close_task_completions_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_task_completions" ADD CONSTRAINT "close_task_completions_task_id_close_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."close_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_task_completions" ADD CONSTRAINT "close_task_completions_completed_by_profiles_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "close_task_completions_key" ON "close_task_completions" USING btree ("period_id","task_id");--> statement-breakpoint
CREATE INDEX "close_tasks_org_idx" ON "close_tasks" USING btree ("organization_id","sort_order");--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "close_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "close_task_completions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "close_tasks_select_member" ON "close_tasks" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "close_task_completions_select_member" ON "close_task_completions" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022).
SELECT public.install_tenant_guard('public.close_tasks');--> statement-breakpoint
SELECT public.install_tenant_guard('public.close_task_completions');--> statement-breakpoint

-- Periods already closed were first closed no later than their last close.
UPDATE "fiscal_periods" SET "first_closed_at" = "closed_at" WHERE "status" <> 'open' AND "closed_at" IS NOT NULL;
