-- ============================================================================
-- STRIP CONSTRUCTION ERP
-- ============================================================================
-- Groundworks pivots from construction ERP to general small-business
-- accounting. This drops the construction layer (jobs, cost codes, change
-- orders, commitments, contract types) plus the employees master, and the
-- job/cost-code tags that hung off AP bills, GL lines, and recurring lines.
--
-- Data remaps (before the enum casts below):
--   membership_role  pm -> bookkeeper, foreman -> viewer
--   approval_scope   change_order thresholds are deleted
--
-- Dimension values that were synced from jobs / cost codes are tenant data
-- and stay put; GL lines tagged with them keep their dimension rows.
-- ============================================================================

ALTER TABLE "employees" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cost_codes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contract_types" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_cost_codes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commitment_lines" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commitments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_order_lines" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_orders" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "employees" CASCADE;--> statement-breakpoint
DROP TABLE "cost_codes" CASCADE;--> statement-breakpoint
DROP TABLE "contract_types" CASCADE;--> statement-breakpoint
DROP TABLE "job_cost_codes" CASCADE;--> statement-breakpoint
DROP TABLE "jobs" CASCADE;--> statement-breakpoint
DROP TABLE "commitment_lines" CASCADE;--> statement-breakpoint
DROP TABLE "commitments" CASCADE;--> statement-breakpoint
DROP TABLE "change_order_lines" CASCADE;--> statement-breakpoint
DROP TABLE "change_orders" CASCADE;--> statement-breakpoint
ALTER TABLE "ap_bill_lines" DROP CONSTRAINT IF EXISTS "ap_bill_lines_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "ap_bill_lines" DROP CONSTRAINT IF EXISTS "ap_bill_lines_cost_code_id_cost_codes_id_fk";
--> statement-breakpoint
ALTER TABLE "ap_bill_lines" DROP CONSTRAINT IF EXISTS "ap_bill_lines_commitment_line_id_commitment_lines_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "scope" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "scope" SET DEFAULT 'ap_bill'::text;--> statement-breakpoint
DELETE FROM "approval_thresholds" WHERE "scope" <> 'ap_bill';--> statement-breakpoint
DROP TYPE "public"."approval_scope";--> statement-breakpoint
CREATE TYPE "public"."approval_scope" AS ENUM('ap_bill');--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "scope" SET DEFAULT 'ap_bill'::"public"."approval_scope";--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "scope" SET DATA TYPE "public"."approval_scope" USING "scope"::"public"."approval_scope";--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'viewer'::text;--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'viewer'::text;--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "required_role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "required_role" SET DEFAULT 'admin'::text;--> statement-breakpoint
UPDATE "memberships" SET "role" = CASE "role" WHEN 'pm' THEN 'bookkeeper' WHEN 'foreman' THEN 'viewer' ELSE "role" END WHERE "role" IN ('pm', 'foreman');--> statement-breakpoint
UPDATE "invitations" SET "role" = CASE "role" WHEN 'pm' THEN 'bookkeeper' WHEN 'foreman' THEN 'viewer' ELSE "role" END WHERE "role" IN ('pm', 'foreman');--> statement-breakpoint
UPDATE "approval_thresholds" SET "required_role" = CASE "required_role" WHEN 'pm' THEN 'bookkeeper' WHEN 'foreman' THEN 'viewer' ELSE "required_role" END WHERE "required_role" IN ('pm', 'foreman');--> statement-breakpoint
DROP TYPE "public"."membership_role";--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'accountant', 'bookkeeper', 'viewer');--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'viewer'::"public"."membership_role";--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DATA TYPE "public"."membership_role" USING "role"::"public"."membership_role";--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'viewer'::"public"."membership_role";--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DATA TYPE "public"."membership_role" USING "role"::"public"."membership_role";--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "required_role" SET DEFAULT 'admin'::"public"."membership_role";--> statement-breakpoint
ALTER TABLE "approval_thresholds" ALTER COLUMN "required_role" SET DATA TYPE "public"."membership_role" USING "required_role"::"public"."membership_role";--> statement-breakpoint
DROP INDEX IF EXISTS "ap_bill_lines_job_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "ap_bill_lines_commitment_idx";--> statement-breakpoint
ALTER TABLE "gl_lines" DROP COLUMN "job_id";--> statement-breakpoint
ALTER TABLE "gl_lines" DROP COLUMN "cost_code_id";--> statement-breakpoint
ALTER TABLE "gl_lines" DROP COLUMN "employee_id";--> statement-breakpoint
ALTER TABLE "recurring_journal_lines" DROP COLUMN "job_id";--> statement-breakpoint
ALTER TABLE "recurring_journal_lines" DROP COLUMN "cost_code_id";--> statement-breakpoint
ALTER TABLE "recurring_journal_lines" DROP COLUMN "employee_id";--> statement-breakpoint
ALTER TABLE "ap_bill_lines" DROP COLUMN "job_id";--> statement-breakpoint
ALTER TABLE "ap_bill_lines" DROP COLUMN "cost_code_id";--> statement-breakpoint
ALTER TABLE "ap_bill_lines" DROP COLUMN "commitment_line_id";--> statement-breakpoint
DROP TYPE "public"."change_order_status";--> statement-breakpoint
DROP TYPE "public"."commitment_status";--> statement-breakpoint
DROP TYPE "public"."commitment_type";--> statement-breakpoint
DROP TYPE "public"."cost_type";--> statement-breakpoint
DROP TYPE "public"."job_status";--> statement-breakpoint
DROP TYPE "public"."employee_classification";