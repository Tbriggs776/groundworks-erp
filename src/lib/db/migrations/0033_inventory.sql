CREATE TYPE "public"."costing_method" AS ENUM('fifo', 'average', 'specific');--> statement-breakpoint
CREATE TYPE "public"."inventory_adjustment_status" AS ENUM('posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."inventory_cost_source" AS ENUM('document', 'engine');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_kind" AS ENUM('opening', 'purchase', 'sale', 'return', 'adjustment');--> statement-breakpoint
ALTER TYPE "public"."item_type" ADD VALUE 'inventory';--> statement-breakpoint
CREATE TABLE "inventory_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"unit_cost" numeric(20, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"adjustment_number" text NOT NULL,
	"adjustment_date" date NOT NULL,
	"kind" text DEFAULT 'adjustment' NOT NULL,
	"offset_account_id" uuid NOT NULL,
	"memo" text,
	"status" "inventory_adjustment_status" DEFAULT 'posted' NOT NULL,
	"gl_journal_id" uuid,
	"void_gl_journal_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_cost_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"posted_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"movement_date" date NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "inventory_movements_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "inventory_movement_kind" NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"cost_source" "inventory_cost_source" NOT NULL,
	"document_cost" numeric(20, 4),
	"cost" numeric(20, 4) DEFAULT '0' NOT NULL,
	"booked_cost" numeric(20, 4) DEFAULT '0' NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"offset_account_id" uuid,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_id" uuid,
	"label" text NOT NULL,
	"voided_at" timestamp with time zone,
	"void_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"costing_method" "costing_method" DEFAULT 'fifo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "quantity" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD COLUMN "unit_cost" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "asset_account_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reorder_point" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD COLUMN "quantity" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD COLUMN "unit_cost" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "inventory_adjustment_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "inventory_adjustment_lines_adjustment_id_inventory_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."inventory_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ADD CONSTRAINT "inventory_adjustment_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_offset_account_id_accounts_id_fk" FOREIGN KEY ("offset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_void_gl_journal_id_gl_journals_id_fk" FOREIGN KEY ("void_gl_journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_postings" ADD CONSTRAINT "inventory_cost_postings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_postings" ADD CONSTRAINT "inventory_cost_postings_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_cost_postings" ADD CONSTRAINT "inventory_cost_postings_journal_id_gl_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."gl_journals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_offset_account_id_accounts_id_fk" FOREIGN KEY ("offset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_adjustment_lines_key" ON "inventory_adjustment_lines" USING btree ("adjustment_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_adjustments_org_number_key" ON "inventory_adjustments" USING btree ("organization_id","adjustment_number");--> statement-breakpoint
CREATE INDEX "inventory_cost_postings_movement_idx" ON "inventory_cost_postings" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" USING btree ("organization_id","item_id","movement_date","sequence");--> statement-breakpoint
CREATE INDEX "inventory_movements_source_idx" ON "inventory_movements" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_settings_org_key" ON "inventory_settings" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "ap_bill_lines" ADD CONSTRAINT "ap_bill_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_lines" ADD CONSTRAINT "bank_transaction_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "inventory_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_cost_postings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inventory_settings_select_member" ON "inventory_settings" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "inventory_movements_select_member" ON "inventory_movements" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "inventory_cost_postings_select_member" ON "inventory_cost_postings" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "inventory_adjustments_select_member" ON "inventory_adjustments" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
CREATE POLICY "inventory_adjustment_lines_select_member" ON "inventory_adjustment_lines" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guards (see 0022). items, bill lines, and bank lines gained foreign keys, so theirs are rebuilt.
SELECT public.install_tenant_guard('public.inventory_settings');--> statement-breakpoint
SELECT public.install_tenant_guard('public.inventory_movements');--> statement-breakpoint
SELECT public.install_tenant_guard('public.inventory_cost_postings');--> statement-breakpoint
SELECT public.install_tenant_guard('public.inventory_adjustments');--> statement-breakpoint
SELECT public.install_tenant_guard('public.inventory_adjustment_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.items');--> statement-breakpoint
SELECT public.install_tenant_guard('public.ap_bill_lines');--> statement-breakpoint
SELECT public.install_tenant_guard('public.bank_transaction_lines');--> statement-breakpoint

-- Numbers for inventory adjustments, for companies that already exist.
INSERT INTO "number_series" ("organization_id", "code", "description", "prefix", "width")
SELECT o.id, 'IA', 'Inventory Adjustments', 'IA-', 6 FROM "organizations" o
ON CONFLICT DO NOTHING;
