CREATE TYPE "public"."change_order_status" AS ENUM('draft', 'pending_approval', 'rejected', 'approved', 'executed', 'voided');--> statement-breakpoint
ALTER TYPE "public"."approval_scope" ADD VALUE 'change_order';--> statement-breakpoint
CREATE TABLE "change_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"change_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"cost_code_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "change_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"co_number" text NOT NULL,
	"external_reference" text,
	"description" text NOT NULL,
	"contract_adjustment" numeric(20, 4) DEFAULT '0' NOT NULL,
	"schedule_adjustment_days" integer DEFAULT 0 NOT NULL,
	"effective_date" date,
	"status" "change_order_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approval_threshold_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason" text,
	"executed_at" timestamp with time zone,
	"executed_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "change_order_lines" ADD CONSTRAINT "change_order_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_lines" ADD CONSTRAINT "change_order_lines_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_lines" ADD CONSTRAINT "change_order_lines_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_submitted_by_profiles_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_approval_threshold_id_approval_thresholds_id_fk" FOREIGN KEY ("approval_threshold_id") REFERENCES "public"."approval_thresholds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_rejected_by_profiles_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_executed_by_profiles_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_order_lines_co_line_key" ON "change_order_lines" USING btree ("change_order_id","line_number");--> statement-breakpoint
CREATE INDEX "change_order_lines_cc_idx" ON "change_order_lines" USING btree ("organization_id","cost_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "change_orders_org_co_number_key" ON "change_orders" USING btree ("organization_id","co_number");--> statement-breakpoint
CREATE INDEX "change_orders_job_idx" ON "change_orders" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE INDEX "change_orders_status_idx" ON "change_orders" USING btree ("organization_id","status");