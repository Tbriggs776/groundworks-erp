CREATE TYPE "public"."customer_type" AS ENUM('commercial', 'residential', 'government', 'non_profit', 'tax_exempt');--> statement-breakpoint
CREATE TYPE "public"."employee_classification" AS ENUM('salary', 'hourly', 'union', 'contractor_1099', 'owner_officer');--> statement-breakpoint
CREATE TYPE "public"."vendor_type" AS ENUM('subcontractor', 'supplier', 'service_provider', 'tax_authority', 'utility', 'other');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"customer_type" "customer_type" DEFAULT 'commercial' NOT NULL,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_payment_terms_days" integer DEFAULT 30 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"credit_limit" numeric(20, 4),
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_id" text,
	"external_id" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"display_name" text,
	"user_id" uuid,
	"classification" "employee_classification" DEFAULT 'hourly' NOT NULL,
	"default_rate" numeric(20, 4),
	"hire_date" date,
	"termination_date" date,
	"email" text,
	"phone" text,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ssn_last4" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"vendor_type" "vendor_type" DEFAULT 'supplier' NOT NULL,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_payment_terms_days" integer DEFAULT 30 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_1099_vendor" boolean DEFAULT false NOT NULL,
	"tin" text,
	"w9_on_file" boolean DEFAULT false NOT NULL,
	"external_id" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_code_key" ON "customers" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_org_code_key" ON "employees" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_org_user_key" ON "employees" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_org_code_key" ON "vendors" USING btree ("organization_id","code");