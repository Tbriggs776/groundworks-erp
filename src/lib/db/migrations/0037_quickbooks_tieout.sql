CREATE TABLE "qbo_tieout_amounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"month" date NOT NULL,
	"qbo_account_id" text NOT NULL,
	"qbo_account_name" text,
	"account_id" uuid,
	"amount" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qbo_imports" ADD COLUMN "tieout_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qbo_tieout_amounts" ADD CONSTRAINT "qbo_tieout_amounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_tieout_amounts" ADD CONSTRAINT "qbo_tieout_amounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_tieout_amounts_key" ON "qbo_tieout_amounts" USING btree ("organization_id","month","qbo_account_id");--> statement-breakpoint

-- Row level security: members can read the tie-out.
ALTER TABLE "qbo_tieout_amounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qbo_tieout_amounts_select_member" ON "qbo_tieout_amounts" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guard (see 0022).
SELECT public.install_tenant_guard('public.qbo_tieout_amounts');
