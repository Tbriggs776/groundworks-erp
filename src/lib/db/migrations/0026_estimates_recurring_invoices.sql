CREATE TYPE "public"."estimate_status" AS ENUM('pending', 'accepted', 'rejected', 'closed');--> statement-breakpoint
CREATE TYPE "public"."recurring_invoice_type" AS ENUM('scheduled', 'reminder', 'unscheduled');--> statement-breakpoint
CREATE TABLE "estimate_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"description" text,
	"quantity" numeric(20, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"estimate_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"estimate_date" date NOT NULL,
	"expiration_date" date,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"subtotal_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"tax_code_id" uuid,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"taxable_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"private_note" text,
	"status" "estimate_status" DEFAULT 'pending' NOT NULL,
	"accepted_by" text,
	"accepted_date" date,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recurring_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"description" text,
	"quantity" numeric(20, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"recurring_invoice_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" "recurring_invoice_type" DEFAULT 'scheduled' NOT NULL,
	"frequency" "recurring_frequency" DEFAULT 'monthly' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"max_occurrences" integer,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"days_in_advance" integer DEFAULT 0 NOT NULL,
	"next_run_date" date,
	"last_run_date" date,
	"last_invoice_id" uuid,
	"last_error" text,
	"po_number" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"subtotal_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"tax_code_id" uuid,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"taxable_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"private_note" text,
	"status" "recurring_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ar_invoice_lines" ADD COLUMN "estimate_line_id" uuid;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "estimate_id" uuid;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "recurring_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_recurring_invoice_id_recurring_invoices_id_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_last_invoice_id_ar_invoices_id_fk" FOREIGN KEY ("last_invoice_id") REFERENCES "public"."ar_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_lines_estimate_line_key" ON "estimate_lines" USING btree ("estimate_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_org_number_key" ON "estimates" USING btree ("organization_id","estimate_number");--> statement-breakpoint
CREATE INDEX "estimates_customer_idx" ON "estimates" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "estimates_status_idx" ON "estimates" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_invoice_lines_parent_line_key" ON "recurring_invoice_lines" USING btree ("recurring_invoice_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_invoices_org_name_key" ON "recurring_invoices" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "recurring_invoices_due_idx" ON "recurring_invoices" USING btree ("organization_id","status","next_run_date");--> statement-breakpoint
CREATE INDEX "recurring_invoices_customer_idx" ON "recurring_invoices" USING btree ("organization_id","customer_id");--> statement-breakpoint
ALTER TABLE "ar_invoice_lines" ADD CONSTRAINT "ar_invoice_lines_estimate_line_id_estimate_lines_id_fk" FOREIGN KEY ("estimate_line_id") REFERENCES "public"."estimate_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_recurring_invoice_id_recurring_invoices_id_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ar_invoice_lines_estimate_line_idx" ON "ar_invoice_lines" USING btree ("estimate_line_id");--> statement-breakpoint
CREATE INDEX "ar_invoices_estimate_idx" ON "ar_invoices" USING btree ("organization_id","estimate_id");--> statement-breakpoint
CREATE INDEX "ar_invoices_recurring_idx" ON "ar_invoices" USING btree ("organization_id","recurring_invoice_id");--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "estimates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "estimate_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "estimates_select_member" ON "estimates" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "estimate_lines_select_member" ON "estimate_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "recurring_invoices_select_member" ON "recurring_invoices" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "recurring_invoice_lines_select_member" ON "recurring_invoice_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards: no reference may cross companies (see 0022). The guard is
-- built from a table's foreign keys, so tables that gained one are rebuilt.
SELECT public.install_tenant_guard('public.estimates');--> statement-breakpoint
SELECT public.install_tenant_guard('public.estimate_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.recurring_invoices');--> statement-breakpoint
SELECT public.install_tenant_guard('public.recurring_invoice_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ar_invoices');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ar_invoice_lines');--> statement-breakpoint

-- Numbering for estimates, for companies that already exist (new companies
-- get it from DEFAULT_NUMBER_SERIES).
INSERT INTO "number_series" ("organization_id", "code", "description", "prefix", "width")
SELECT o.id, 'EST', 'Estimates', 'EST-', 6 FROM "organizations" o
ON CONFLICT DO NOTHING;
