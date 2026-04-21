CREATE TYPE "public"."account_category" AS ENUM('balance_sheet', 'income_statement');--> statement-breakpoint
CREATE TYPE "public"."account_subcategory" AS ENUM('cash', 'receivables', 'inventory', 'other_current_asset', 'fixed_assets', 'other_asset', 'payables', 'accrued_liabilities', 'other_current_liability', 'lt_debt', 'other_liability', 'equity', 'retained_earnings', 'operating_revenue', 'other_revenue', 'cogs_labor', 'cogs_materials', 'cogs_equipment', 'cogs_subcontractor', 'cogs_other', 'operating_expense', 'sga', 'interest', 'tax', 'other_expense');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('posting', 'heading', 'total', 'begin_total', 'end_total');--> statement-breakpoint
CREATE TYPE "public"."combination_status" AS ENUM('allowed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."debit_credit_enforced" AS ENUM('debit_only', 'credit_only', 'either');--> statement-breakpoint
CREATE TYPE "public"."dimension_value_posting" AS ENUM('no_code', 'code_mandatory', 'same_code', 'same_code_and_same_value');--> statement-breakpoint
CREATE TYPE "public"."exchange_rate_type" AS ENUM('spot', 'average', 'historical', 'budget', 'consolidation');--> statement-breakpoint
CREATE TYPE "public"."fiscal_year_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('open', 'soft_closed', 'hard_closed');--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"display_decimals" integer DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate_type" "exchange_rate_type" NOT NULL,
	"effective_date" date NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"inverse_rate" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "account_category" NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"account_type" "account_type" DEFAULT 'posting' NOT NULL,
	"totaling" text,
	"indentation" integer DEFAULT 0 NOT NULL,
	"category" "account_category" NOT NULL,
	"subcategory" "account_subcategory" NOT NULL,
	"normal_balance" "normal_balance" NOT NULL,
	"category_id" uuid,
	"direct_posting" boolean DEFAULT true NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"is_control" boolean DEFAULT false NOT NULL,
	"is_cash" boolean DEFAULT false NOT NULL,
	"is_reconciliation" boolean DEFAULT false NOT NULL,
	"is_statistical" boolean DEFAULT false NOT NULL,
	"debit_credit_enforced" "debit_credit_enforced" DEFAULT 'either' NOT NULL,
	"currency" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_default_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"default_value_id" uuid,
	"value_posting" "dimension_value_posting" DEFAULT 'no_code' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dimension_combinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dimension_1_id" uuid NOT NULL,
	"value_1_id" uuid NOT NULL,
	"dimension_2_id" uuid NOT NULL,
	"value_2_id" uuid NOT NULL,
	"combination" "combination_status" DEFAULT 'blocked' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dimension_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_value_id" uuid,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"is_total" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"period_no" integer NOT NULL,
	"period_code" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fiscal_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"year_label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "fiscal_year_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "posting_date_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"allow_post_from" date,
	"allow_post_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"start_number" integer DEFAULT 1 NOT NULL,
	"increment" integer DEFAULT 1 NOT NULL,
	"width" integer DEFAULT 6 NOT NULL,
	"last_used_number" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "hard_close_override_password_hash" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "require_reason_for_override" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_from_currency_currencies_code_fk" FOREIGN KEY ("from_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_to_currency_currencies_code_fk" FOREIGN KEY ("to_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_categories" ADD CONSTRAINT "account_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_categories" ADD CONSTRAINT "account_categories_parent_id_account_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."account_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_category_id_account_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."account_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_default_dimensions" ADD CONSTRAINT "account_default_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_default_dimensions" ADD CONSTRAINT "account_default_dimensions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_default_dimensions" ADD CONSTRAINT "account_default_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_default_dimensions" ADD CONSTRAINT "account_default_dimensions_default_value_id_dimension_values_id_fk" FOREIGN KEY ("default_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_combinations" ADD CONSTRAINT "dimension_combinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_combinations" ADD CONSTRAINT "dimension_combinations_dimension_1_id_dimensions_id_fk" FOREIGN KEY ("dimension_1_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_combinations" ADD CONSTRAINT "dimension_combinations_value_1_id_dimension_values_id_fk" FOREIGN KEY ("value_1_id") REFERENCES "public"."dimension_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_combinations" ADD CONSTRAINT "dimension_combinations_dimension_2_id_dimensions_id_fk" FOREIGN KEY ("dimension_2_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_combinations" ADD CONSTRAINT "dimension_combinations_value_2_id_dimension_values_id_fk" FOREIGN KEY ("value_2_id") REFERENCES "public"."dimension_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_parent_value_id_dimension_values_id_fk" FOREIGN KEY ("parent_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_date_restrictions" ADD CONSTRAINT "posting_date_restrictions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_date_restrictions" ADD CONSTRAINT "posting_date_restrictions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reason_codes" ADD CONSTRAINT "reason_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_codes" ADD CONSTRAINT "source_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rates_lookup_idx" ON "exchange_rates" USING btree ("organization_id","from_currency","to_currency","rate_type","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_unique_key" ON "exchange_rates" USING btree ("organization_id","from_currency","to_currency","rate_type","effective_date");--> statement-breakpoint
CREATE INDEX "account_categories_org_idx" ON "account_categories" USING btree ("organization_id","category");--> statement-breakpoint
CREATE INDEX "account_categories_parent_idx" ON "account_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_code_key" ON "accounts" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "accounts_org_active_idx" ON "accounts" USING btree ("organization_id","is_active","is_blocked");--> statement-breakpoint
CREATE INDEX "accounts_org_category_idx" ON "accounts" USING btree ("organization_id","category");--> statement-breakpoint
CREATE INDEX "accounts_org_subcategory_idx" ON "accounts" USING btree ("organization_id","subcategory");--> statement-breakpoint
CREATE INDEX "accounts_control_idx" ON "accounts" USING btree ("organization_id","is_control");--> statement-breakpoint
CREATE UNIQUE INDEX "acct_default_dims_key" ON "account_default_dimensions" USING btree ("account_id","dimension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dim_combinations_key" ON "dimension_combinations" USING btree ("organization_id","value_1_id","value_2_id");--> statement-breakpoint
CREATE INDEX "dim_combinations_lookup_idx" ON "dimension_combinations" USING btree ("organization_id","dimension_1_id","dimension_2_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_values_dim_code_key" ON "dimension_values" USING btree ("organization_id","dimension_id","code");--> statement-breakpoint
CREATE INDEX "dimension_values_parent_idx" ON "dimension_values" USING btree ("parent_value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dimensions_org_code_key" ON "dimensions" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_org_code_key" ON "fiscal_periods" USING btree ("organization_id","period_code");--> statement-breakpoint
CREATE INDEX "fiscal_periods_org_dates_idx" ON "fiscal_periods" USING btree ("organization_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "fiscal_periods_year_idx" ON "fiscal_periods" USING btree ("fiscal_year_id","period_no");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_years_org_label_key" ON "fiscal_years" USING btree ("organization_id","year_label");--> statement-breakpoint
CREATE INDEX "fiscal_years_org_start_idx" ON "fiscal_years" USING btree ("organization_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_date_restrictions_key" ON "posting_date_restrictions" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_org_code_key" ON "number_series" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "reason_codes_org_code_key" ON "reason_codes" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "source_codes_org_code_key" ON "source_codes" USING btree ("organization_id","code");