CREATE TYPE "public"."commitment_status" AS ENUM('draft', 'issued', 'closed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."commitment_type" AS ENUM('po', 'subcontract');--> statement-breakpoint
CREATE TABLE "commitment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"cost_code_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"invoiced_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"commitment_number" text NOT NULL,
	"external_reference" text,
	"type" "commitment_type" DEFAULT 'po' NOT NULL,
	"status" "commitment_status" DEFAULT 'draft' NOT NULL,
	"description" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"invoiced_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"effective_date" date,
	"expiration_date" date,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "commitment_line_id" uuid;--> statement-breakpoint
ALTER TABLE "commitment_lines" ADD CONSTRAINT "commitment_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_lines" ADD CONSTRAINT "commitment_lines_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_lines" ADD CONSTRAINT "commitment_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_lines" ADD CONSTRAINT "commitment_lines_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_issued_by_profiles_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commitment_lines_co_line_key" ON "commitment_lines" USING btree ("commitment_id","line_number");--> statement-breakpoint
CREATE INDEX "commitment_lines_cc_idx" ON "commitment_lines" USING btree ("organization_id","cost_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_org_number_key" ON "commitments" USING btree ("organization_id","commitment_number");--> statement-breakpoint
CREATE INDEX "commitments_job_idx" ON "commitments" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE INDEX "commitments_vendor_idx" ON "commitments" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "commitments_status_idx" ON "commitments" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_commitment_line_id_commitment_lines_id_fk" FOREIGN KEY ("commitment_line_id") REFERENCES "public"."commitment_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ap_bill_lines_commitment_idx" ON "ap_bill_lines" USING btree ("organization_id","commitment_line_id");