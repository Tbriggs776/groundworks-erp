"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { customers, type Address, type Contact } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";

const AddressSchema = z.object({
  type: z.enum(["billing", "shipping", "remit", "mailing", "other"]),
  street1: z.string().trim(),
  street2: z.string().optional().or(z.literal("")),
  city: z.string().optional().or(z.literal("")),
  state: z.string().optional().or(z.literal("")),
  zip: z.string().optional().or(z.literal("")),
  country: z.string().optional().or(z.literal("")),
});
const ContactSchema = z.object({
  name: z.string().trim().min(1),
  title: z.string().optional().or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  isPrimary: z.boolean().optional(),
});

const CustomerSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(100).optional().or(z.literal("")),
  customerType: z.enum([
    "commercial",
    "residential",
    "government",
    "non_profit",
    "tax_exempt",
  ]),
  defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365),
  currency: z.string().length(3).default("USD"),
  creditLimit: z.string().optional().or(z.literal("")),
  taxExempt: z.coerce.boolean().default(false),
  taxId: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().default(true),
  addresses: z.array(AddressSchema).default([]),
  contacts: z.array(ContactSchema).default([]),
});

export type CustomerInput = z.input<typeof CustomerSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createCustomer(input: CustomerInput): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = CustomerSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const [row] = await db
      .insert(customers)
      .values({
        organizationId,
        code: parsed.data.code,
        name: parsed.data.name,
        displayName: parsed.data.displayName || null,
        customerType: parsed.data.customerType,
        defaultPaymentTermsDays: parsed.data.defaultPaymentTermsDays,
        currency: parsed.data.currency.toUpperCase(),
        creditLimit: parsed.data.creditLimit || null,
        taxExempt: parsed.data.taxExempt,
        taxId: parsed.data.taxId || null,
        notes: parsed.data.notes || null,
        isActive: parsed.data.isActive,
        addresses: parsed.data.addresses as Address[],
        contacts: parsed.data.contacts as Contact[],
      })
      .returning({ id: customers.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "customer.created",
      entityType: "customer",
      entityId: row.id,
      metadata: { code: parsed.data.code, name: parsed.data.name },
    });

    revalidatePath("/customers");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Customer code "${parsed.data.code}" already in use.` };
    }
    console.error("[customers] createCustomer failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateCustomer(
  customerId: string,
  input: CustomerInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = CustomerSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db
      .update(customers)
      .set({
        code: parsed.data.code,
        name: parsed.data.name,
        displayName: parsed.data.displayName || null,
        customerType: parsed.data.customerType,
        defaultPaymentTermsDays: parsed.data.defaultPaymentTermsDays,
        currency: parsed.data.currency.toUpperCase(),
        creditLimit: parsed.data.creditLimit || null,
        taxExempt: parsed.data.taxExempt,
        taxId: parsed.data.taxId || null,
        notes: parsed.data.notes || null,
        isActive: parsed.data.isActive,
        addresses: parsed.data.addresses as Address[],
        contacts: parsed.data.contacts as Contact[],
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.organizationId, organizationId)
        )
      );

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "customer.updated",
      entityType: "customer",
      entityId: customerId,
      metadata: { code: parsed.data.code },
    });

    revalidatePath("/customers");
    return { ok: true, id: customerId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict." };
    }
    console.error("[customers] updateCustomer failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
