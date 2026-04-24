CREATE TABLE "approval_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" "approval_scope" DEFAULT 'ap_bill' NOT NULL,
	"tier_name" text NOT NULL,
	"min_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"max_amount" numeric(20, 4),
	"required_role" "membership_role" DEFAULT 'admin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ap_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"job_id" uuid,
	"cost_code_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ap_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_number" text NOT NULL,
	"vendor_invoice_number" text,
	"vendor_id" uuid NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"discount_date" date,
	"posting_date" date,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"subtotal_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_percent" numeric(10, 6) DEFAULT '0' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" "ap_bill_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approval_threshold_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason" text,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"gl_journal_id" uuid,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"void_gl_journal_id" uuid,
	"description" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approval_thresholds" ADD CONSTRAINT "approval_thresholds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_bill_id_ap_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."ap_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_submitted_by_profiles_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_approval_threshold_id_approval_thresholds_id_fk" FOREIGN KEY ("approval_threshold_id") REFERENCES "public"."approval_thresholds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_rejected_by_profiles_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_thresholds_org_scope_name_key" ON "approval_thresholds" USING btree ("organization_id","scope","tier_name");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_bill_lines_bill_line_key" ON "ap_bill_lines" USING btree ("bill_id","line_number");--> statement-breakpoint
CREATE INDEX "ap_bill_lines_job_idx" ON "ap_bill_lines" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_bills_org_billnum_key" ON "ap_bills" USING btree ("organization_id","bill_number");--> statement-breakpoint
CREATE INDEX "ap_bills_org_status_idx" ON "ap_bills" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ap_bills_vendor_idx" ON "ap_bills" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "ap_bills_due_idx" ON "ap_bills" USING btree ("organization_id","due_date");