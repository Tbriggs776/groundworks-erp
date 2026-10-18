import type { db } from "@/lib/db/client";
import {
  accounts,
  approvalThresholds,
  dimensions,
  numberSeries,
  reasonCodes,
  sourceCodes,
} from "@/lib/db/schema";
import { DEFAULT_COA } from "./default-coa";

/**
 * Tenant defaults seeded on org creation. Called inside the onboarding
 * transaction. Safe to run multiple times — the catch-and-skip on unique
 * violations makes it idempotent per org.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Seed the system dimensions every org gets — QuickBooks' Class and
 * Location plus Department and a lightweight Project tag. `code` is
 * fixed; `name` is tenant-editable. Sort order controls UI display.
 */
export const SYSTEM_DIMENSIONS: Array<{
  code: string;
  name: string;
  description: string;
}> = [
  { code: "CLASS", name: "Class", description: "Business segment, product line, or service line." },
  { code: "LOCATION", name: "Location", description: "Store, office, region, or other location." },
  { code: "DEPARTMENT", name: "Department", description: "Organizational department." },
  { code: "PROJECT", name: "Project", description: "Customer project or engagement, for profitability by project." },
];

/**
 * Seed the standard source codes every org gets. Matches the
 * journal source enum.
 */
export const SYSTEM_SOURCE_CODES: Array<{ code: string; description: string }> = [
  { code: "GJ", description: "General Journal" },
  { code: "SJ", description: "Sales / AR Journal" },
  { code: "PJ", description: "Purchase / AP Journal" },
  { code: "CR", description: "Cash Receipts" },
  { code: "CD", description: "Cash Disbursements" },
  { code: "PY", description: "Payroll" },
  { code: "ADJ", description: "Adjusting Entry" },
  { code: "REV", description: "Reversing Entry" },
  { code: "YE", description: "Year-End Close" },
  { code: "IC", description: "Intercompany" },
  { code: "INV", description: "Inventory" },
  { code: "FA", description: "Fixed Assets" },
  { code: "REC", description: "Recurring Entry" },
  { code: "ALLOC", description: "Allocation Entry" },
];

export const DEFAULT_REASON_CODES: Array<{ code: string; description: string }> = [
  { code: "AUDIT", description: "Auditor adjustment" },
  { code: "ACCRUAL", description: "Month-end accrual" },
  { code: "RECLASS", description: "Reclassification" },
  { code: "CORRECTION", description: "Correction of prior error" },
];

export const DEFAULT_NUMBER_SERIES: Array<{
  code: string;
  description: string;
  prefix: string;
  width: number;
}> = [
  { code: "JE", description: "Journal Entries", prefix: "JE-", width: 6 },
  { code: "REV", description: "Reversing Entries", prefix: "REV-", width: 6 },
  { code: "REC", description: "Recurring-Generated Entries", prefix: "REC-", width: 6 },
  { code: "ALLOC", description: "Allocation Entries", prefix: "ALLOC-", width: 6 },
  { code: "AP", description: "Bills", prefix: "BILL-", width: 6 },
  { code: "APPAY", description: "Bill Payments", prefix: "BPAY-", width: 6 },
  { code: "INV", description: "Invoices", prefix: "INV-", width: 6 },
  { code: "ARPAY", description: "Customer Payments", prefix: "PMT-", width: 6 },
];

export async function seedOrganizationDefaults(
  tx: Tx,
  organizationId: string,
  opts: { includeDefaultCoa: boolean }
): Promise<void> {
  // Dimensions — system, code-stable, name-editable
  await tx
    .insert(dimensions)
    .values(
      SYSTEM_DIMENSIONS.map((d, i) => ({
        organizationId,
        code: d.code,
        name: d.name,
        description: d.description,
        isSystem: true,
        sortOrder: i,
      }))
    )
    .onConflictDoNothing();

  // Source codes
  await tx
    .insert(sourceCodes)
    .values(
      SYSTEM_SOURCE_CODES.map((s) => ({
        organizationId,
        code: s.code,
        description: s.description,
        isSystem: true,
      }))
    )
    .onConflictDoNothing();

  // Reason codes
  await tx
    .insert(reasonCodes)
    .values(
      DEFAULT_REASON_CODES.map((r) => ({
        organizationId,
        code: r.code,
        description: r.description,
      }))
    )
    .onConflictDoNothing();

  // Number series
  await tx
    .insert(numberSeries)
    .values(
      DEFAULT_NUMBER_SERIES.map((n) => ({
        organizationId,
        code: n.code,
        description: n.description,
        prefix: n.prefix,
        width: n.width,
      }))
    )
    .onConflictDoNothing();

  // Default CoA (optional — migrating orgs import their own)
  if (opts.includeDefaultCoa) {
    await tx
      .insert(accounts)
      .values(DEFAULT_COA.map((a) => ({ ...a, organizationId })))
      .onConflictDoNothing();
  }

  // Default approval threshold — one tier spanning all amounts, admin
  // role required. Admins can add more tiers via
  // /settings/approval-thresholds.
  await tx
    .insert(approvalThresholds)
    .values({
      organizationId,
      scope: "ap_bill",
      tierName: "Default",
      minAmount: "0",
      maxAmount: null,
      requiredRole: "admin",
      sortOrder: 0,
    })
    .onConflictDoNothing();
}
