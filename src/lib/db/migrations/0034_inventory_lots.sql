ALTER TYPE "public"."inventory_movement_kind" ADD VALUE 'vendor_return';--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "lot_expires_on" date;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN "quantity" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN "unit_cost" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "ar_invoice_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "credit_memo_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "refund_receipt_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "sales_receipt_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD COLUMN "lot_expires_on" date;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD COLUMN "lot_expires_on" date;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_item_number_key" ON "inventory_lots" USING btree ("organization_id","item_id","lot_number");--> statement-breakpoint
ALTER TABLE "vendor_credit_lines" ADD CONSTRAINT "vendor_credit_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "inventory_lots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inventory_lots_select_member" ON "inventory_lots" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022). Movements and vendor credit lines gained foreign keys, so theirs are rebuilt.
SELECT public.install_tenant_guard('public.inventory_lots');--> statement-breakpoint
SELECT public.install_tenant_guard('public.inventory_movements');--> statement-breakpoint
SELECT public.install_tenant_guard('public.vendor_credit_lines');
