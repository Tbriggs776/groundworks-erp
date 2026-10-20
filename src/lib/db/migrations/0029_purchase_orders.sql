CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'pending_approval', 'rejected', 'open', 'closed');--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"account_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(20, 4) DEFAULT '1' NOT NULL,
	"unit_cost" numeric(20, 4) NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "purchase_order_lines_positive" CHECK ("purchase_order_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"po_number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"po_date" date NOT NULL,
	"expected_date" date,
	"ship_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vendor_message" text,
	"memo" text,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approval_threshold_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason" text,
	"sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_reason" text,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "purchase_order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submitted_by_profiles_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approval_threshold_id_approval_thresholds_id_fk" FOREIGN KEY ("approval_threshold_id") REFERENCES "public"."approval_thresholds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_rejected_by_profiles_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_po_line_key" ON "purchase_order_lines" USING btree ("purchase_order_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_org_number_key" ON "purchase_orders" USING btree ("organization_id","po_number");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_bills" ADD CONSTRAINT "ap_bills_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ap_bill_lines_po_line_idx" ON "ap_bill_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "ap_bills_po_idx" ON "ap_bills" USING btree ("organization_id","purchase_order_id");--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "purchase_orders_select_member" ON "purchase_orders" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "purchase_order_lines_select_member" ON "purchase_order_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards: no reference may cross companies (see 0022). The guard is
-- built from a table's foreign keys, so the bill tables that gained one are
-- rebuilt.
SELECT public.install_tenant_guard('public.purchase_orders');--> statement-breakpoint
SELECT public.install_tenant_guard('public.purchase_order_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ap_bills');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ap_bill_lines');--> statement-breakpoint

-- Numbering for purchase orders, for companies that already exist (new
-- companies get it from DEFAULT_NUMBER_SERIES).
INSERT INTO "number_series" ("organization_id", "code", "description", "prefix", "width")
SELECT o.id, 'PO', 'Purchase Orders', 'PO-', 6 FROM "organizations" o
ON CONFLICT DO NOTHING;
