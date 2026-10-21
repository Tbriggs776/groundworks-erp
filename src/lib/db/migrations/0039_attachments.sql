CREATE TYPE "public"."attachment_entity" AS ENUM('bank_transaction', 'statement_line', 'bill', 'bill_payment', 'vendor_credit', 'vendor_refund', 'purchase_order', 'invoice', 'estimate', 'customer_payment', 'sales_receipt', 'credit_memo', 'refund', 'journal', 'inventory_adjustment', 'reconciliation', 'vendor', 'customer');--> statement-breakpoint
CREATE TYPE "public"."attachment_read_status" AS ENUM('none', 'pending', 'read', 'failed');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" "attachment_entity",
	"entity_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"read_status" "attachment_read_status" DEFAULT 'none' NOT NULL,
	"read_error" text,
	"read_at" timestamp with time zone,
	"read_model" text,
	"extracted" jsonb,
	"note" text,
	"uploaded_by" uuid,
	"uploaded_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_profiles_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_agent_id_agents_id_fk" FOREIGN KEY ("uploaded_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachments_sha_idx" ON "attachments" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key" ON "attachments" USING btree ("storage_path");--> statement-breakpoint

-- Row level security: members read the list; the files themselves sit in a
-- private bucket only the server reaches.
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attachments_select_member" ON "attachments" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guard (see 0022).
SELECT public.install_tenant_guard('public.attachments');--> statement-breakpoint

-- entity_id points at a different table per entity_type, so no foreign key
-- can check it: this does. The document must exist in the same company.
CREATE OR REPLACE FUNCTION public.attachment_entity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  tbl text;
  owner uuid;
BEGIN
  IF NEW.entity_type IS NULL AND NEW.entity_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
    RAISE EXCEPTION 'attachment: entity_type and entity_id go together' USING ERRCODE = '23514';
  END IF;
  tbl := CASE NEW.entity_type
    WHEN 'bank_transaction' THEN 'bank_transactions'
    WHEN 'statement_line' THEN 'bank_statement_lines'
    WHEN 'bill' THEN 'ap_bills'
    WHEN 'bill_payment' THEN 'ap_payments'
    WHEN 'vendor_credit' THEN 'vendor_credits'
    WHEN 'vendor_refund' THEN 'vendor_refunds'
    WHEN 'purchase_order' THEN 'purchase_orders'
    WHEN 'invoice' THEN 'ar_invoices'
    WHEN 'estimate' THEN 'estimates'
    WHEN 'customer_payment' THEN 'ar_payments'
    WHEN 'sales_receipt' THEN 'sales_receipts'
    WHEN 'credit_memo' THEN 'credit_memos'
    WHEN 'refund' THEN 'refund_receipts'
    WHEN 'journal' THEN 'gl_journals'
    WHEN 'inventory_adjustment' THEN 'inventory_adjustments'
    WHEN 'reconciliation' THEN 'reconciliations'
    WHEN 'vendor' THEN 'vendors'
    WHEN 'customer' THEN 'customers'
  END;
  EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', tbl) INTO owner USING NEW.entity_id;
  IF owner IS NULL OR owner <> NEW.organization_id THEN
    RAISE EXCEPTION 'attachment: % % is not in this company', NEW.entity_type, NEW.entity_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER attachments_entity_guard BEFORE INSERT OR UPDATE OF entity_type, entity_id, organization_id ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION public.attachment_entity_guard();--> statement-breakpoint

-- The private bucket the files live in (Supabase Storage). No storage
-- policies: only the server, with the service role, reads or writes it.
-- Skipped where Supabase Storage isn't installed (local test databases).
DO $gw$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES ('attachments', 'attachments', false, 4194304)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$gw$;
