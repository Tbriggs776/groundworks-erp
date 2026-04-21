"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";

/**
 * Chart of Accounts CRUD. Gated to admin+ so random users can't monkey with
 * the ledger structure. Owners and admins can do everything; accountants can
 * create and edit accounts but not delete (accountant doesn't reach admin).
 */

const ACCOUNT_SUBCATEGORIES = [
  "cash", "receivables", "inventory", "other_current_asset",
  "fixed_assets", "other_asset",
  "payables", "accrued_liabilities", "other_current_liability",
  "lt_debt", "other_liability",
  "equity", "retained_earnings",
  "operating_revenue", "other_revenue",
  "cogs_labor", "cogs_materials", "cogs_equipment", "cogs_subcontractor", "cogs_other",
  "operating_expense", "sga", "interest", "tax", "other_expense",
] as const;

const AccountSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  accountType: z.enum(["posting", "heading", "total", "begin_total", "end_total"]),
  category: z.enum(["balance_sheet", "income_statement"]),
  subcategory: z.enum(ACCOUNT_SUBCATEGORIES),
  normalBalance: z.enum(["debit", "credit"]),
  isActive: z.coerce.boolean(),
  isBlocked: z.coerce.boolean(),
  directPosting: z.coerce.boolean(),
  isControl: z.coerce.boolean(),
  isCash: z.coerce.boolean(),
  isStatistical: z.coerce.boolean(),
});

export type AccountFormState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "success"; id: string };

function parseFormData(formData: FormData) {
  return AccountSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: formData.get("description"),
    accountType: formData.get("accountType"),
    category: formData.get("category"),
    subcategory: formData.get("subcategory"),
    normalBalance: formData.get("normalBalance"),
    isActive: formData.get("isActive") === "on",
    isBlocked: formData.get("isBlocked") === "on",
    directPosting: formData.get("directPosting") === "on",
    isControl: formData.get("isControl") === "on",
    isCash: formData.get("isCash") === "on",
    isStatistical: formData.get("isStatistical") === "on",
  });
}

export async function createAccount(
  _prev: AccountFormState,
  formData: FormData
): Promise<AccountFormState> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();
  const actorId = actor?.id ?? null;

  const parsed = parseFormData(formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Fix the errors below.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;

  try {
    const [row] = await db
      .insert(accounts)
      .values({
        organizationId,
        ...data,
        description: data.description || null,
      })
      .returning({ id: accounts.id });

    await writeAudit({
      organizationId,
      actorId,
      event: "account.created",
      entityType: "account",
      entityId: row.id,
      metadata: { code: data.code, name: data.name },
    });

    revalidatePath("/accounts");
    return { status: "success", id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return {
        status: "error",
        message: `An account with code "${data.code}" already exists.`,
        fieldErrors: { code: ["Already in use."] },
      };
    }
    console.error("[accounts] createAccount failed:", err);
    return { status: "error", message: "Could not create account." };
  }
}

export async function updateAccount(
  accountId: string,
  _prev: AccountFormState,
  formData: FormData
): Promise<AccountFormState> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();
  const actorId = actor?.id ?? null;

  const parsed = parseFormData(formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Fix the errors below.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  try {
    await db
      .update(accounts)
      .set({
        ...parsed.data,
        description: parsed.data.description || null,
      })
      .where(
        and(
          eq(accounts.id, accountId),
          eq(accounts.organizationId, organizationId)
        )
      );

    await writeAudit({
      organizationId,
      actorId,
      event: "account.updated",
      entityType: "account",
      entityId: accountId,
      metadata: { changes: parsed.data },
    });

    revalidatePath("/accounts");
    return { status: "success", id: accountId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return {
        status: "error",
        message: "Account code conflict.",
        fieldErrors: { code: ["Already in use."] },
      };
    }
    console.error("[accounts] updateAccount failed:", err);
    return { status: "error", message: "Could not update account." };
  }
}
