CREATE TYPE "public"."credit_memo_status" AS ENUM('draft', 'open', 'applied', 'voided');--> statement-breakpoint
CREATE TYPE "public"."refund_kind" AS ENUM('items', 'credit');--> statement-breakpoint
CREATE TYPE "public"."sales_doc_status" AS ENUM('draft', 'posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."tax_payment_status" AS ENUM('posted', 'voided');--> statement-breakpoint
CREATE TABLE "tax_agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"registration_number" text,
	"filing_frequency" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tax_code_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"agency_id" uuid NOT NULL,
	"rate_percent" numeric(9, 4) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ar_credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"credit_memo_id" uuid,
	"payment_id" uuid,
	"invoice_id" uuid,
	"refund_id" uuid,
	"amount" numeric(20, 4) NOT NULL,
	"applied_on" date NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ar_credit_applications_one_source" CHECK (num_nonnulls("ar_credit_applications"."credit_memo_id", "ar_credit_applications"."payment_id") = 1),
	CONSTRAINT "ar_credit_applications_one_target" CHECK (num_nonnulls("ar_credit_applications"."invoice_id", "ar_credit_applications"."refund_id") = 1),
	CONSTRAINT "ar_credit_applications_positive" CHECK ("ar_credit_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_memo_lines" (
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
	"credit_memo_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"memo_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"memo_date" date NOT NULL,
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
	"status" "credit_memo_status" DEFAULT 'draft' NOT NULL,
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
CREATE TABLE "refund_receipt_lines" (
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
	"refund_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"refund_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"refund_date" date NOT NULL,
	"kind" "refund_kind" DEFAULT 'items' NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"bank_account_id" uuid NOT NULL,
	"credit_memo_id" uuid,
	"payment_id" uuid,
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
	"status" "sales_doc_status" DEFAULT 'draft' NOT NULL,
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
CREATE TABLE "sales_receipt_lines" (
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
	"receipt_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"customer_id" uuid,
	"receipt_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"deposit_account_id" uuid NOT NULL,
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
	"status" "sales_doc_status" DEFAULT 'draft' NOT NULL,
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
CREATE TABLE "sales_tax_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid,
	"sales_receipt_id" uuid,
	"credit_memo_id" uuid,
	"refund_id" uuid,
	"tax_rate_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"rate_percent" numeric(9, 4) NOT NULL,
	"taxable_amount" numeric(20, 4) NOT NULL,
	"tax_amount" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sales_tax_lines_one_document" CHECK (num_nonnulls("sales_tax_lines"."invoice_id", "sales_tax_lines"."sales_receipt_id", "sales_tax_lines"."credit_memo_id", "sales_tax_lines"."refund_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "sales_tax_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_number" text NOT NULL,
	"agency_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"reference" text,
	"memo" text,
	"status" "tax_payment_status" DEFAULT 'posted' NOT NULL,
	"posted_at" timestamp with time zone,
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
ALTER TABLE "organizations" ADD COLUMN "auto_apply_credits" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "default_tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "ar_invoice_lines" ADD COLUMN "taxable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "tax_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "taxable_amount" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD COLUMN "tax_amount" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "taxable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD COLUMN "sales_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_agencies" ADD CONSTRAINT "tax_agencies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_agencies" ADD CONSTRAINT "tax_agencies_liability_account_id_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_components" ADD CONSTRAINT "tax_code_components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_components" ADD CONSTRAINT "tax_code_components_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_components" ADD CONSTRAINT "tax_code_components_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_agency_id_tax_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."tax_agencies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_credit_memo_id_credit_memos_id_fk" FOREIGN KEY ("credit_memo_id") REFERENCES "public"."credit_memos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_payment_id_ar_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."ar_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_invoice_id_ar_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."ar_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_refund_id_refund_receipts_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ADD CONSTRAINT "ar_credit_applications_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD CONSTRAINT "credit_memo_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD CONSTRAINT "credit_memo_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD CONSTRAINT "credit_memo_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD CONSTRAINT "credit_memo_lines_credit_memo_id_credit_memos_id_fk" FOREIGN KEY ("credit_memo_id") REFERENCES "public"."credit_memos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipt_lines" ADD CONSTRAINT "refund_receipt_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipt_lines" ADD CONSTRAINT "refund_receipt_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipt_lines" ADD CONSTRAINT "refund_receipt_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipt_lines" ADD CONSTRAINT "refund_receipt_lines_refund_id_refund_receipts_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_credit_memo_id_credit_memos_id_fk" FOREIGN KEY ("credit_memo_id") REFERENCES "public"."credit_memos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_payment_id_ar_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."ar_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD CONSTRAINT "sales_receipt_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD CONSTRAINT "sales_receipt_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD CONSTRAINT "sales_receipt_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD CONSTRAINT "sales_receipt_lines_receipt_id_sales_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."sales_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_deposit_account_id_accounts_id_fk" FOREIGN KEY ("deposit_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_receipts" ADD CONSTRAINT "sales_receipts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_invoice_id_ar_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."ar_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_sales_receipt_id_sales_receipts_id_fk" FOREIGN KEY ("sales_receipt_id") REFERENCES "public"."sales_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_credit_memo_id_credit_memos_id_fk" FOREIGN KEY ("credit_memo_id") REFERENCES "public"."credit_memos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_refund_id_refund_receipts_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_tax_rate_id_tax_rates_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_agency_id_tax_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."tax_agencies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ADD CONSTRAINT "sales_tax_lines_liability_account_id_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_agency_id_tax_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."tax_agencies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ADD CONSTRAINT "sales_tax_payments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_agencies_org_name_key" ON "tax_agencies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_code_components_key" ON "tax_code_components" USING btree ("tax_code_id","tax_rate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_codes_org_name_key" ON "tax_codes" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_org_name_key" ON "tax_rates" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "tax_rates_agency_idx" ON "tax_rates" USING btree ("organization_id","agency_id");--> statement-breakpoint
CREATE INDEX "ar_credit_apps_memo_idx" ON "ar_credit_applications" USING btree ("organization_id","credit_memo_id");--> statement-breakpoint
CREATE INDEX "ar_credit_apps_payment_idx" ON "ar_credit_applications" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "ar_credit_apps_invoice_idx" ON "ar_credit_applications" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "ar_credit_apps_refund_idx" ON "ar_credit_applications" USING btree ("organization_id","refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_memo_lines_key" ON "credit_memo_lines" USING btree ("credit_memo_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_memos_org_number_key" ON "credit_memos" USING btree ("organization_id","memo_number");--> statement-breakpoint
CREATE INDEX "credit_memos_customer_idx" ON "credit_memos" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "credit_memos_status_idx" ON "credit_memos" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_receipt_lines_key" ON "refund_receipt_lines" USING btree ("refund_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_receipts_org_number_key" ON "refund_receipts" USING btree ("organization_id","refund_number");--> statement-breakpoint
CREATE INDEX "refund_receipts_customer_idx" ON "refund_receipts" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "refund_receipts_status_idx" ON "refund_receipts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_receipt_lines_key" ON "sales_receipt_lines" USING btree ("receipt_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_receipts_org_number_key" ON "sales_receipts" USING btree ("organization_id","receipt_number");--> statement-breakpoint
CREATE INDEX "sales_receipts_customer_idx" ON "sales_receipts" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "sales_receipts_status_idx" ON "sales_receipts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "sales_tax_lines_agency_idx" ON "sales_tax_lines" USING btree ("organization_id","agency_id");--> statement-breakpoint
CREATE INDEX "sales_tax_lines_invoice_idx" ON "sales_tax_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "sales_tax_lines_receipt_idx" ON "sales_tax_lines" USING btree ("sales_receipt_id");--> statement-breakpoint
CREATE INDEX "sales_tax_lines_memo_idx" ON "sales_tax_lines" USING btree ("credit_memo_id");--> statement-breakpoint
CREATE INDEX "sales_tax_lines_refund_idx" ON "sales_tax_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_tax_payments_org_number_key" ON "sales_tax_payments" USING btree ("organization_id","payment_number");--> statement-breakpoint
CREATE INDEX "sales_tax_payments_agency_idx" ON "sales_tax_payments" USING btree ("organization_id","agency_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_default_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("default_tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_sales_receipt_id_sales_receipts_id_fk" FOREIGN KEY ("sales_receipt_id") REFERENCES "public"."sales_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_transaction_lines_receipt_idx" ON "bank_transaction_lines" USING btree ("sales_receipt_id");

-- Members read their companies' sales tax and sales document rows; writes go through the app.
ALTER TABLE "tax_agencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_code_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_memos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_receipt_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ar_credit_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_tax_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_tax_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tax_agencies_select_member" ON "tax_agencies" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "tax_rates_select_member" ON "tax_rates" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "tax_codes_select_member" ON "tax_codes" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "tax_code_components_select_member" ON "tax_code_components" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "sales_receipts_select_member" ON "sales_receipts" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "sales_receipt_lines_select_member" ON "sales_receipt_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "credit_memos_select_member" ON "credit_memos" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "credit_memo_lines_select_member" ON "credit_memo_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "refund_receipts_select_member" ON "refund_receipts" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "refund_receipt_lines_select_member" ON "refund_receipt_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "ar_credit_applications_select_member" ON "ar_credit_applications" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "sales_tax_lines_select_member" ON "sales_tax_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "sales_tax_payments_select_member" ON "sales_tax_payments" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards: no reference may cross companies (see 0022). The guard is
-- built from a table's foreign keys, so tables that gained one are rebuilt.
SELECT public.install_tenant_guard('public.tax_agencies');--> statement-breakpoint
SELECT public.install_tenant_guard('public.tax_rates');--> statement-breakpoint
SELECT public.install_tenant_guard('public.tax_codes');--> statement-breakpoint
SELECT public.install_tenant_guard('public.tax_code_components');--> statement-breakpoint
SELECT public.install_tenant_guard('public.sales_receipts');--> statement-breakpoint
SELECT public.install_tenant_guard('public.sales_receipt_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.credit_memos');--> statement-breakpoint
SELECT public.install_tenant_guard('public.credit_memo_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.refund_receipts');--> statement-breakpoint
SELECT public.install_tenant_guard('public.refund_receipt_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ar_credit_applications');--> statement-breakpoint
SELECT public.install_tenant_guard('public.sales_tax_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.sales_tax_payments');--> statement-breakpoint
SELECT public.install_tenant_guard('public.customers');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ar_invoices');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_transaction_lines');--> statement-breakpoint

-- Numbering for the new documents, for companies that already exist
-- (new companies get them from DEFAULT_NUMBER_SERIES).
INSERT INTO "number_series" ("organization_id", "code", "description", "prefix", "width")
SELECT o.id, s.code, s.description, s.prefix, 6
  FROM "organizations" o
 CROSS JOIN (VALUES ('SR', 'Sales Receipts', 'SR-'),
                    ('CM', 'Credit Memos', 'CM-'),
                    ('RR', 'Refund Receipts', 'RR-'),
                    ('STP', 'Sales Tax Payments', 'STP-')) AS s(code, description, prefix)
ON CONFLICT DO NOTHING;
