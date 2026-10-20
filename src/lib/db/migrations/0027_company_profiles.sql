CREATE TABLE "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_name" text,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"phone" text,
	"email" text,
	"website" text,
	"tax_id" text,
	"document_footer" text,
	"logo_data" text,
	"logo_content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_profiles_org_key" ON "company_profiles" USING btree ("organization_id");--> statement-breakpoint

-- Row level security: members of the company can read; writes go through the app.
ALTER TABLE "company_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "company_profiles_select_member" ON "company_profiles" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint

-- Tenant guard (see 0022).
SELECT public.install_tenant_guard('public.company_profiles');
