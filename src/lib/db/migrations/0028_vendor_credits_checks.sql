CREATE TYPE "public"."vendor_credit_status" AS ENUM('draft', 'open', 'applied', 'voided');--> statement-breakpoint
CREATE TYPE "public"."vendor_refund_status" AS ENUM('draft', 'posted', 'voided');--> statement-breakpoint
CREATE TABLE "ap_credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_credit_id" uuid NOT NULL,
	"bill_id" uuid,
	"vendor_refund_id" uuid,
	"amount" numeric(20, 4) NOT NULL,
	"applied_on" date NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ap_credit_apps_one_target" CHECK (("ap_credit_applications"."bill_id" IS NULL) <> ("ap_credit_applications"."vendor_refund_id" IS NULL)),
	CONSTRAINT "ap_credit_apps_positive" CHECK ("ap_credit_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_credit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_credit_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vendor_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"credit_date" date NOT NULL,
	"vendor_reference" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"status" "vendor_credit_status" DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"gl_journal_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"void_gl_journal_id" uuid,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vendor_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"refund_number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"refund_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"bank_account_id" uuid NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"vendor_credit_id" uuid,
	"memo" text,
	"status" "vendor_refund_status" DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"gl_journal_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"void_gl_journal_id" uuid,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_profiles" ADD COLUMN "check_offset_x" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD COLUMN "check_offset_y" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "next_check_number" integer;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD COLUMN "to_print" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD COLUMN "printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "to_print" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_vendor_credit_id_vendor_credits_id_fk" FOREIGN KEY ("vendor_credit_id") REFERENCES "public"."vendor_credits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_bill_id_ap_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."ap_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_vendor_refund_id_vendor_refunds_id_fk" FOREIGN KEY ("vendor_refund_id") REFERENCES "public"."vendor_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ADD CONSTRAINT "ap_credit_applications_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD CONSTRAINT "vendor_credit_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD CONSTRAINT "vendor_credit_lines_vendor_credit_id_vendor_credits_id_fk" FOREIGN KEY ("vendor_credit_id") REFERENCES "public"."vendor_credits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD CONSTRAINT "vendor_credit_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_vendor_credit_id_vendor_credits_id_fk" FOREIGN KEY ("vendor_credit_id") REFERENCES "public"."vendor_credits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ap_credit_apps_credit_idx" ON "ap_credit_applications" USING btree ("organization_id","vendor_credit_id");--> statement-breakpoint
CREATE INDEX "ap_credit_apps_bill_idx" ON "ap_credit_applications" USING btree ("organization_id","bill_id");--> statement-breakpoint
CREATE INDEX "ap_credit_apps_refund_idx" ON "ap_credit_applications" USING btree ("organization_id","vendor_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_credit_lines_credit_line_key" ON "vendor_credit_lines" USING btree ("vendor_credit_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_credits_org_number_key" ON "vendor_credits" USING btree ("organization_id","credit_number");--> statement-breakpoint
CREATE INDEX "vendor_credits_vendor_idx" ON "vendor_credits" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_credits_status_idx" ON "vendor_credits" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_refunds_org_number_key" ON "vendor_refunds" USING btree ("organization_id","refund_number");--> statement-breakpoint
CREATE INDEX "vendor_refunds_vendor_idx" ON "vendor_refunds" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_refunds_status_idx" ON "vendor_refunds" USING btree ("organization_id","status");--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "vendor_credits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ap_credit_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "vendor_credits_select_member" ON "vendor_credits" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "vendor_credit_lines_select_member" ON "vendor_credit_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "vendor_refunds_select_member" ON "vendor_refunds" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "ap_credit_applications_select_member" ON "ap_credit_applications" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022).
SELECT public.install_tenant_guard('public.vendor_credits');--> statement-breakpoint
SELECT public.install_tenant_guard('public.vendor_credit_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.vendor_refunds');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ap_credit_applications');--> statement-breakpoint

-- Numbering for the new documents, for companies that already exist (new
-- companies get them from DEFAULT_NUMBER_SERIES).
INSERT INTO "number_series" ("organization_id", "code", "description", "prefix", "width")
SELECT o.id, s.code, s.description, s.prefix, 6
  FROM "organizations" o
 CROSS JOIN (VALUES ('VC', 'Vendor Credits', 'VC-'),
                    ('VR', 'Vendor Refunds', 'VR-')) AS s(code, description, prefix)
ON CONFLICT DO NOTHING;
