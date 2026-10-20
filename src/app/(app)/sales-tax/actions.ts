"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as liability from "@/lib/sales-tax/liability";
import * as rates from "@/lib/sales-tax/rates";

/** Sales tax server actions: thin wrappers over src/lib/sales-tax/*. */

function revalidate() {
  revalidatePath("/sales-tax");
  revalidatePath("/ar", "layout");
  revalidatePath("/customers");
}

export async function createAgency(input: { name: string; liabilityAccountId?: string; filingFrequency?: "monthly" | "quarterly" | "annually" }): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await rates.createTaxAgency(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function setAgencyActive(id: string, isActive: boolean): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await rates.updateTaxAgency(ctx, { id, isActive })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function createRate(input: { name: string; agencyId?: string; ratePercent?: string; componentIds?: string[] }): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await rates.createTaxRate(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function updateRate(input: { id: string; ratePercent?: string; isActive?: boolean }): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await rates.updateTaxRate(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function recordPayment(input: {
  agencyId: string;
  paymentDate: string;
  periodEnd: string;
  amount: string;
  bankAccountId: string;
  reference?: string;
}): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await liability.recordTaxPayment(ctx, input)).id }));
  if (r.ok) {
    revalidate();
    revalidatePath("/banking", "layout");
  }
  return r;
}

export async function voidPayment(id: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({ id: (await liability.voidTaxPayment(ctx, { id, reason })).id }));
  if (r.ok) {
    revalidate();
    revalidatePath("/banking", "layout");
  }
  return r;
}
