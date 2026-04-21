CREATE TYPE "public"."bal_account_type" AS ENUM('gl', 'bank', 'customer', 'vendor', 'fixed_asset', 'ic_partner');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('open', 'posting', 'posted', 'error');--> statement-breakpoint
CREATE TYPE "public"."journal_source" AS ENUM('manual', 'ap', 'ar', 'cash_receipt', 'cash_disbursement', 'payroll', 'inventory', 'fixed_asset', 'ic', 'recurring', 'reversing', 'adjusting', 'year_end_close');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('draft', 'pending_approval', 'posted', 'reversed');--> statement-breakpoint
CREATE TABLE "gl_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid,
	"journal_template_id" uuid,
	"journal_number" text NOT NULL,
	"document_no" text,
	"journal_date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"source_code_id" uuid NOT NULL,
	"source" "journal_source" NOT NULL,
	"source_document_type" text,
	"source_document_id" uuid,
	"reason_code_id" uuid,
	"description" text NOT NULL,
	"status" "journal_status" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reverses_journal_id" uuid,
	"reversed_by_journal_id" uuid,
	"auto_reverse_date" date,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"override_hard_close" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"override_approved_by" uuid,
	"recurring_journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gl_line_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gl_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"debit_local" numeric(20, 4) DEFAULT '0' NOT NULL,
	"credit_local" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"reference" text,
	"job_id" uuid,
	"cost_code_id" uuid,
	"customer_id" uuid,
	"vendor_id" uuid,
	"employee_id" uuid,
	"fixed_asset_id" uuid,
	"bank_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "gl_lines_debit_xor_credit" CHECK (("gl_lines"."debit" > 0 AND "gl_lines"."credit" = 0) OR ("gl_lines"."credit" > 0 AND "gl_lines"."debit" = 0)),
	CONSTRAINT "gl_lines_local_matches_side" CHECK ((("gl_lines"."debit" > 0 AND "gl_lines"."debit_local" > 0 AND "gl_lines"."credit_local" = 0) OR ("gl_lines"."credit" > 0 AND "gl_lines"."credit_local" > 0 AND "gl_lines"."debit_local" = 0)))
);
--> statement-breakpoint
CREATE TABLE "journal_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_template_id" uuid,
	"code" text NOT NULL,
	"description" text,
	"posting_date" date,
	"reason_code_id" uuid,
	"source_code_id" uuid,
	"status" "batch_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journal_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_code_id" uuid NOT NULL,
	"number_series_id" uuid NOT NULL,
	"default_account_id" uuid,
	"default_bal_account_type" "bal_account_type" DEFAULT 'gl' NOT NULL,
	"force_posting_date" boolean DEFAULT false NOT NULL,
	"reason_code_mandatory" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_batch_id_journal_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."journal_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_journal_template_id_journal_templates_id_fk" FOREIGN KEY ("journal_template_id") REFERENCES "public"."journal_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_source_code_id_source_codes_id_fk" FOREIGN KEY ("source_code_id") REFERENCES "public"."source_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_reason_code_id_reason_codes_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_reverses_journal_id_gl_journals_id_fk" FOREIGN KEY ("reverses_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_reversed_by_journal_id_gl_journals_id_fk" FOREIGN KEY ("reversed_by_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_journals" ADD CONSTRAINT "gl_journals_override_approved_by_profiles_id_fk" FOREIGN KEY ("override_approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_dimensions" ADD CONSTRAINT "gl_line_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_dimensions" ADD CONSTRAINT "gl_line_dimensions_line_id_gl_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."gl_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_dimensions" ADD CONSTRAINT "gl_line_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_line_dimensions" ADD CONSTRAINT "gl_line_dimensions_value_id_dimension_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_journal_id_gl_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_journal_template_id_journal_templates_id_fk" FOREIGN KEY ("journal_template_id") REFERENCES "public"."journal_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_reason_code_id_reason_codes_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_source_code_id_source_codes_id_fk" FOREIGN KEY ("source_code_id") REFERENCES "public"."source_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_source_code_id_source_codes_id_fk" FOREIGN KEY ("source_code_id") REFERENCES "public"."source_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_number_series_id_number_series_id_fk" FOREIGN KEY ("number_series_id") REFERENCES "public"."number_series"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_templates" ADD CONSTRAINT "journal_templates_default_account_id_accounts_id_fk" FOREIGN KEY ("default_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gl_journals_org_number_key" ON "gl_journals" USING btree ("organization_id","journal_number");--> statement-breakpoint
CREATE INDEX "gl_journals_org_period_status_idx" ON "gl_journals" USING btree ("organization_id","period_id","status");--> statement-breakpoint
CREATE INDEX "gl_journals_org_date_idx" ON "gl_journals" USING btree ("organization_id","journal_date");--> statement-breakpoint
CREATE INDEX "gl_journals_org_source_idx" ON "gl_journals" USING btree ("organization_id","source");--> statement-breakpoint
CREATE INDEX "gl_journals_reverses_idx" ON "gl_journals" USING btree ("reverses_journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_line_dimensions_line_dim_key" ON "gl_line_dimensions" USING btree ("line_id","dimension_id");--> statement-breakpoint
CREATE INDEX "gl_line_dimensions_value_idx" ON "gl_line_dimensions" USING btree ("organization_id","dimension_id","value_id");--> statement-breakpoint
CREATE INDEX "gl_lines_journal_idx" ON "gl_lines" USING btree ("journal_id","line_number");--> statement-breakpoint
CREATE INDEX "gl_lines_org_account_idx" ON "gl_lines" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_lines_journal_line_key" ON "gl_lines" USING btree ("journal_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_batches_org_code_key" ON "journal_batches" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "journal_batches_org_status_idx" ON "journal_batches" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_templates_org_code_key" ON "journal_templates" USING btree ("organization_id","code");