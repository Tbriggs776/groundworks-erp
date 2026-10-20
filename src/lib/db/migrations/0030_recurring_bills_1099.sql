CREATE TYPE "public"."form_1099_box" AS ENUM('nec_1', 'misc_1', 'misc_2', 'misc_3', 'misc_6', 'misc_10');--> statement-breakpoint
CREATE TYPE "public"."recurring_bill_type" AS ENUM('scheduled', 'reminder', 'unscheduled');--> statement-breakpoint
CREATE TABLE "recurring_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recurring_bill_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recurring_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"type" "recurring_bill_type" DEFAULT 'scheduled' NOT NULL,
	"frequency" "recurring_frequency" DEFAULT 'monthly' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"max_occurrences" integer,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"days_in_advance" integer DEFAULT 0 NOT NULL,
	"next_run_date" date,
	"last_run_date" date,
	"last_bill_id" uuid,
	"last_error" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"description" text,
	"notes" text,
	"status" "recurring_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "form_1099_box" "form_1099_box";--> statement-breakpoint
ALTER TABLE "ap_bills" ADD COLUMN "recurring_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_recurring_bill_id_recurring_bills_id_fk" FOREIGN KEY ("recurring_bill_id") REFERENCES "public"."recurring_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_lines" ADD CONSTRAINT "recurring_bill_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_last_bill_id_ap_bills_id_fk" FOREIGN KEY ("last_bill_id") REFERENCES "public"."ap_bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_bill_lines_parent_line_key" ON "recurring_bill_lines" USING btree ("recurring_bill_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_bills_org_name_key" ON "recurring_bills" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "recurring_bills_due_idx" ON "recurring_bills" USING btree ("organization_id","status","next_run_date");--> statement-breakpoint
CREATE INDEX "recurring_bills_vendor_idx" ON "recurring_bills" USING btree ("organization_id","vendor_id");--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_recurring_bill_id_recurring_bills_id_fk" FOREIGN KEY ("recurring_bill_id") REFERENCES "public"."recurring_bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "recurring_bills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_bill_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurring_bills_select_member" ON "recurring_bills" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "recurring_bill_lines_select_member" ON "recurring_bill_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022). ap_bills gained a foreign key, so its guard is rebuilt.
SELECT public.install_tenant_guard('public.recurring_bills');--> statement-breakpoint
SELECT public.install_tenant_guard('public.recurring_bill_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ap_bills');--> statement-breakpoint

-- 1099 boxes for the default accounts companies already have, where the
-- account still has its default code and name (new companies get them from
-- DEFAULT_COA).
UPDATE "accounts" SET "form_1099_box" = d.box::form_1099_box
  FROM (VALUES ('5200', 'Equipment Rental', 'misc_1'),
               ('5300', 'Contract Labor', 'nec_1'),
               ('6150', 'Contractors', 'nec_1'),
               ('6350', 'Legal & Professional Fees', 'nec_1'),
               ('6600', 'Rent & Lease', 'misc_1')) AS d(code, name, box)
 WHERE "accounts"."code" = d.code AND "accounts"."name" = d.name AND "accounts"."form_1099_box" IS NULL;
