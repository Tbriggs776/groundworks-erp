CREATE TYPE "public"."ap_payment_status" AS ENUM('draft', 'posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('check', 'ach', 'wire', 'credit_card', 'cash', 'other');--> statement-breakpoint
CREATE TABLE "ap_payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"applied_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ap_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"bank_account_id" uuid NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"applied_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"status" "ap_payment_status" DEFAULT 'draft' NOT NULL,
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
ALTER TABLE "ap_payment_applications" ADD CONSTRAINT "ap_payment_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payment_applications" ADD CONSTRAINT "ap_payment_applications_payment_id_ap_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."ap_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payment_applications" ADD CONSTRAINT "ap_payment_applications_bill_id_ap_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."ap_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_posted_by_profiles_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ap_pay_app_unique" ON "ap_payment_applications" USING btree ("payment_id","bill_id");--> statement-breakpoint
CREATE INDEX "ap_pay_app_bill_idx" ON "ap_payment_applications" USING btree ("organization_id","bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_payments_org_num_key" ON "ap_payments" USING btree ("organization_id","payment_number");--> statement-breakpoint
CREATE INDEX "ap_payments_vendor_idx" ON "ap_payments" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "ap_payments_status_idx" ON "ap_payments" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ap_payments_date_idx" ON "ap_payments" USING btree ("organization_id","payment_date");