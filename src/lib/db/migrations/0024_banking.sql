CREATE TYPE "public"."bank_rule_direction" AS ENUM('money_in', 'money_out', 'any');--> statement-breakpoint
CREATE TYPE "public"."bank_txn_status" AS ENUM('draft', 'posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."bank_txn_type" AS ENUM('expense', 'check', 'deposit', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."clearing_status" AS ENUM('cleared', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('in_progress', 'completed', 'undone');--> statement-breakpoint
CREATE TYPE "public"."statement_format" AS ENUM('csv', 'ofx', 'qfx');--> statement-breakpoint
CREATE TYPE "public"."statement_line_status" AS ENUM('for_review', 'matched', 'added', 'excluded');--> statement-breakpoint
CREATE TABLE "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"account_id" uuid,
	"direction" "bank_rule_direction" DEFAULT 'any' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"match_all" boolean DEFAULT true NOT NULL,
	"category_account_id" uuid,
	"transfer_account_id" uuid,
	"vendor_id" uuid,
	"customer_id" uuid,
	"payee_name" text,
	"memo" text,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_add" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" text,
	"format" "statement_format" NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"start_date" date,
	"end_date" date,
	"ledger_balance" numeric(20, 4),
	"ledger_balance_date" date,
	"imported_by" uuid,
	"imported_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"posted_date" date NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"description" text NOT NULL,
	"payee" text,
	"reference" text,
	"fit_id" text NOT NULL,
	"status" "statement_line_status" DEFAULT 'for_review' NOT NULL,
	"bank_transaction_id" uuid,
	"rule_id" uuid,
	"reviewed_by" uuid,
	"reviewed_by_agent_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_statement_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"gl_line_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transaction_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"description" text,
	"customer_id" uuid,
	"ar_payment_id" uuid,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"txn_number" text NOT NULL,
	"type" "bank_txn_type" NOT NULL,
	"txn_date" date NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"transfer_account_id" uuid,
	"vendor_id" uuid,
	"customer_id" uuid,
	"payee_name" text,
	"method" "payment_method",
	"reference" text,
	"memo" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"total_amount" numeric(20, 4) NOT NULL,
	"status" "bank_txn_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"gl_journal_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"void_gl_journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gl_line_clearings" (
	"gl_line_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "clearing_status" DEFAULT 'cleared' NOT NULL,
	"reconciliation_id" uuid,
	"cleared_by" uuid,
	"cleared_by_agent_id" uuid,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_end_date" date NOT NULL,
	"statement_ending_balance" numeric(20, 4) NOT NULL,
	"beginning_balance" numeric(20, 4) NOT NULL,
	"cleared_balance" numeric(20, 4),
	"cleared_count" integer,
	"status" "reconciliation_status" DEFAULT 'in_progress' NOT NULL,
	"started_by" uuid,
	"started_by_agent_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_category_account_id_accounts_id_fk" FOREIGN KEY ("category_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_imported_by_profiles_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_imported_by_agent_id_agents_id_fk" FOREIGN KEY ("imported_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_bank_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_statement_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_rule_id_bank_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."bank_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_reviewed_by_profiles_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ADD CONSTRAINT "bank_statement_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ADD CONSTRAINT "bank_statement_matches_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ADD CONSTRAINT "bank_statement_matches_gl_line_id_gl_lines_id_fk" FOREIGN KEY ("gl_line_id") REFERENCES "public"."gl_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_ar_payment_id_ar_payments_id_fk" FOREIGN KEY ("ar_payment_id") REFERENCES "public"."ar_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ADD CONSTRAINT "gl_line_clearings_gl_line_id_gl_lines_id_fk" FOREIGN KEY ("gl_line_id") REFERENCES "public"."gl_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ADD CONSTRAINT "gl_line_clearings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ADD CONSTRAINT "gl_line_clearings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ADD CONSTRAINT "gl_line_clearings_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ADD CONSTRAINT "gl_line_clearings_cleared_by_profiles_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ADD CONSTRAINT "gl_line_clearings_cleared_by_agent_id_agents_id_fk" FOREIGN KEY ("cleared_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_started_by_profiles_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_started_by_agent_id_agents_id_fk" FOREIGN KEY ("started_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_completed_by_profiles_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_undone_by_profiles_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_rules_org_idx" ON "bank_rules" USING btree ("organization_id","priority");--> statement-breakpoint
CREATE INDEX "bank_statement_imports_account_idx" ON "bank_statement_imports" USING btree ("organization_id","account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_fit_key" ON "bank_statement_lines" USING btree ("account_id","fit_id");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_review_idx" ON "bank_statement_lines" USING btree ("organization_id","account_id","status","posted_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_matches_gl_line_key" ON "bank_statement_matches" USING btree ("gl_line_id");--> statement-breakpoint
CREATE INDEX "bank_statement_matches_line_idx" ON "bank_statement_matches" USING btree ("statement_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transaction_lines_txn_line_key" ON "bank_transaction_lines" USING btree ("transaction_id","line_number");--> statement-breakpoint
CREATE INDEX "bank_transaction_lines_payment_idx" ON "bank_transaction_lines" USING btree ("ar_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_org_num_key" ON "bank_transactions" USING btree ("organization_id","txn_number");--> statement-breakpoint
CREATE INDEX "bank_transactions_account_idx" ON "bank_transactions" USING btree ("organization_id","bank_account_id","txn_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_status_idx" ON "bank_transactions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "gl_line_clearings_account_idx" ON "gl_line_clearings" USING btree ("organization_id","account_id","status");--> statement-breakpoint
CREATE INDEX "reconciliations_account_idx" ON "reconciliations" USING btree ("organization_id","account_id","statement_end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliations_one_open_key" ON "reconciliations" USING btree ("account_id") WHERE status = 'in_progress';--> statement-breakpoint

-- Members read their companies' banking rows; writes go through the app.
ALTER TABLE "bank_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gl_line_clearings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bank_transactions_select_member" ON "bank_transactions" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "bank_transaction_lines_select_member" ON "bank_transaction_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "bank_statement_imports_select_member" ON "bank_statement_imports" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "bank_statement_lines_select_member" ON "bank_statement_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "bank_statement_matches_select_member" ON "bank_statement_matches" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "bank_rules_select_member" ON "bank_rules" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "gl_line_clearings_select_member" ON "gl_line_clearings" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "reconciliations_select_member" ON "reconciliations" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards: no reference may cross companies (see 0022).
SELECT public.install_tenant_guard('public.bank_transactions');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_transaction_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_statement_imports');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_statement_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_statement_matches');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_rules');--> statement-breakpoint
SELECT public.install_tenant_guard('public.gl_line_clearings');--> statement-breakpoint
SELECT public.install_tenant_guard('public.reconciliations');--> statement-breakpoint

-- Numbering for the new documents, for companies that already exist
-- (new companies get them from DEFAULT_NUMBER_SERIES).
INSERT INTO "number_series" ("organization_id", "code", "description", "prefix", "width")
SELECT o.id, s.code, s.description, s.prefix, 6
  FROM "organizations" o
 CROSS JOIN (VALUES ('EXP', 'Expenses and Checks', 'EXP-'),
                    ('DEP', 'Deposits', 'DEP-'),
                    ('XFER', 'Transfers', 'XFER-')) AS s(code, description, prefix)
ON CONFLICT DO NOTHING;
