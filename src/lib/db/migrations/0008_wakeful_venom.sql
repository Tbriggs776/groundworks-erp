CREATE TYPE "public"."allocation_type" AS ENUM('fixed', 'statistical');--> statement-breakpoint
CREATE TYPE "public"."recurring_frequency" AS ENUM('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannually', 'annually');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TABLE "recurring_journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recurring_journal_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 4) DEFAULT '0' NOT NULL,
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
	CONSTRAINT "recurring_lines_debit_xor_credit" CHECK (("recurring_journal_lines"."debit" > 0 AND "recurring_journal_lines"."credit" = 0) OR ("recurring_journal_lines"."credit" > 0 AND "recurring_journal_lines"."debit" = 0))
);
--> statement-breakpoint
CREATE TABLE "recurring_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"journal_template_id" uuid NOT NULL,
	"reason_code_id" uuid,
	"journal_description" text NOT NULL,
	"frequency" "recurring_frequency" NOT NULL,
	"frequency_day" integer,
	"frequency_weekday" integer,
	"start_date" date NOT NULL,
	"end_date" date,
	"next_run_date" date NOT NULL,
	"last_run_date" date,
	"last_run_journal_id" uuid,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "recurring_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recurring_line_dimensions" (
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
CREATE TABLE "allocation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"allocation_type" "allocation_type" DEFAULT 'fixed' NOT NULL,
	"source_statistical_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "allocation_target_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "allocation_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"allocation_group_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"percent" numeric(10, 6) DEFAULT '0' NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budget_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budget_entry_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_locked" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recurring_journal_lines" ADD CONSTRAINT "recurring_journal_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_lines" ADD CONSTRAINT "recurring_journal_lines_recurring_journal_id_recurring_journals_id_fk" FOREIGN KEY ("recurring_journal_id") REFERENCES "public"."recurring_journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_lines" ADD CONSTRAINT "recurring_journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_journal_template_id_journal_templates_id_fk" FOREIGN KEY ("journal_template_id") REFERENCES "public"."journal_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_reason_code_id_reason_codes_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_last_run_journal_id_gl_journals_id_fk" FOREIGN KEY ("last_run_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_line_dimensions" ADD CONSTRAINT "recurring_line_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_line_dimensions" ADD CONSTRAINT "recurring_line_dimensions_line_id_recurring_journal_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."recurring_journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_line_dimensions" ADD CONSTRAINT "recurring_line_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_line_dimensions" ADD CONSTRAINT "recurring_line_dimensions_value_id_dimension_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_groups" ADD CONSTRAINT "allocation_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_groups" ADD CONSTRAINT "allocation_groups_source_statistical_account_id_accounts_id_fk" FOREIGN KEY ("source_statistical_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_target_dimensions" ADD CONSTRAINT "allocation_target_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_target_dimensions" ADD CONSTRAINT "allocation_target_dimensions_target_id_allocation_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."allocation_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_target_dimensions" ADD CONSTRAINT "allocation_target_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_target_dimensions" ADD CONSTRAINT "allocation_target_dimensions_value_id_dimension_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_targets" ADD CONSTRAINT "allocation_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_targets" ADD CONSTRAINT "allocation_targets_allocation_group_id_allocation_groups_id_fk" FOREIGN KEY ("allocation_group_id") REFERENCES "public"."allocation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_targets" ADD CONSTRAINT "allocation_targets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entries" ADD CONSTRAINT "budget_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entries" ADD CONSTRAINT "budget_entries_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entries" ADD CONSTRAINT "budget_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entries" ADD CONSTRAINT "budget_entries_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entry_dimensions" ADD CONSTRAINT "budget_entry_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entry_dimensions" ADD CONSTRAINT "budget_entry_dimensions_entry_id_budget_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."budget_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entry_dimensions" ADD CONSTRAINT "budget_entry_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_entry_dimensions" ADD CONSTRAINT "budget_entry_dimensions_value_id_dimension_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_locked_by_profiles_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_lines_parent_line_key" ON "recurring_journal_lines" USING btree ("recurring_journal_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_journals_org_code_key" ON "recurring_journals" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "recurring_journals_due_idx" ON "recurring_journals" USING btree ("organization_id","status","next_run_date");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_line_dims_line_dim_key" ON "recurring_line_dimensions" USING btree ("line_id","dimension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_groups_org_code_key" ON "allocation_groups" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_target_dims_key" ON "allocation_target_dimensions" USING btree ("target_id","dimension_id");--> statement-breakpoint
CREATE INDEX "allocation_targets_group_idx" ON "allocation_targets" USING btree ("allocation_group_id");--> statement-breakpoint
CREATE INDEX "budget_entries_budget_idx" ON "budget_entries" USING btree ("budget_id","account_id","period_id");--> statement-breakpoint
CREATE INDEX "budget_entries_period_idx" ON "budget_entries" USING btree ("organization_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_entry_dims_key" ON "budget_entry_dimensions" USING btree ("entry_id","dimension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_org_code_key" ON "budgets" USING btree ("organization_id","code");