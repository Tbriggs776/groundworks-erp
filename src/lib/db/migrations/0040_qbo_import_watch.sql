CREATE TABLE "qbo_import_watch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"step" text NOT NULL,
	"entity" text,
	"qbo_id" text,
	"label" text,
	"suspect_step" text,
	"suspect_entity" text,
	"suspect_qbo_id" text,
	"suspect_label" text,
	"stops" integer DEFAULT 0 NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qbo_import_watch" ADD CONSTRAINT "qbo_import_watch_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_import_watch_org_key" ON "qbo_import_watch" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "qbo_import_watch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "qbo_import_watch_select_member" ON "qbo_import_watch" FOR SELECT TO authenticated USING (public.is_member_of(organization_id));--> statement-breakpoint
SELECT public.install_tenant_guard('public.qbo_import_watch');
