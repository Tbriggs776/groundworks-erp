import type { db } from "@/lib/db/client";
import {
  accounts,
  dimensions,
  numberSeries,
  reasonCodes,
  sourceCodes,
} from "@/lib/db/schema";
import { CONTRACTOR_COA } from "./contractor-coa";

/**
 * Tenant defaults seeded on org creation. Called inside the onboarding
 * transaction. Safe to run multiple times — the catch-and-skip on unique
 * violations makes it idempotent per org.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Seed the six system dimensions every org gets. `code` is fixed; `name` is
 * tenant-editable. Sort order controls UI display.
 */
export const SYSTEM_DIMENSIONS: Array<{
  code: string;
  name: string;
  description: string;
}> = [
  { code: "JOB", name: "Job", description: "Project / job. Primary construction dimension." },
  { code: "COST_CODE", name: "Cost Code", description: "WBS / phase code (CSI MasterFormat or custom)." },
  { code: "DEPARTMENT", name: "Department", description: "Organizational department." },
  { code: "LOCATION", name: "Location", description: "Yard, office, or geographic location." },
  { code: "EQUIPMENT", name: "Equipment", description: "Specific piece of equipment for cost/revenue tagging." },
  { code: "PROJECT_MANAGER", name: "Project Manager", description: "Responsible PM — for performance reporting." },
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
];

export async function seedOrganizationDefaults(
  tx: Tx,
  organizationId: string,
  opts: { includeContractorCoa: boolean }
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

  // Contractor CoA (optional)
  if (opts.includeContractorCoa) {
    await tx
      .insert(accounts)
      .values(
        CONTRACTOR_COA.map((a) => ({
          ...a,
          organizationId,
        }))
      )
      .onConflictDoNothing();
  }
}
