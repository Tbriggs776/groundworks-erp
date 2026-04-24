CREATE TABLE "cost_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_cost_code_id" uuid,
	"cost_type" "cost_type" DEFAULT 'other' NOT NULL,
	"dimension_value_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contract_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_cost_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"cost_code_id" uuid NOT NULL,
	"budget_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"committed_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"actual_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"customer_id" uuid NOT NULL,
	"project_manager_id" uuid,
	"status" "job_status" DEFAULT 'bid' NOT NULL,
	"contract_type_id" uuid,
	"contract_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"contract_date" date,
	"start_date" date,
	"estimated_end_date" date,
	"actual_end_date" date,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retainage_percent" numeric(10, 6) DEFAULT '0' NOT NULL,
	"dimension_value_id" uuid,
	"status_changed_at" timestamp with time zone,
	"status_changed_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_parent_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("parent_cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_types" ADD CONSTRAINT "contract_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cost_codes" ADD CONSTRAINT "job_cost_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cost_codes" ADD CONSTRAINT "job_cost_codes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cost_codes" ADD CONSTRAINT "job_cost_codes_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_manager_id_profiles_id_fk" FOREIGN KEY ("project_manager_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contract_type_id_contract_types_id_fk" FOREIGN KEY ("contract_type_id") REFERENCES "public"."contract_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_changed_by_profiles_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_codes_org_code_key" ON "cost_codes" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_types_org_code_key" ON "contract_types" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cost_codes_unique" ON "job_cost_codes" USING btree ("job_id","cost_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_org_code_key" ON "jobs" USING btree ("organization_id","code");