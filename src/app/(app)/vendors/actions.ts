"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { vendors, type Address, type Contact } from "@/lib/db/schema";
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

const VendorSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(100).optional().or(z.literal("")),
  vendorType: z.enum([
    "subcontractor",
    "supplier",
    "service_provider",
    "tax_authority",
    "utility",
    "other",
  ]),
  defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365),
  currency: z.string().length(3).default("USD"),
  is1099Vendor: z.coerce.boolean().default(false),
  tin: z.string().optional().or(z.literal("")),
  w9OnFile: z.coerce.boolean().default(false),
  notes: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().default(true),
  addresses: z.array(AddressSchema).default([]),
  contacts: z.array(ContactSchema).default([]),
});

export type VendorInput = z.input<typeof VendorSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createVendor(input: VendorInput): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = VendorSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const [row] = await db
      .insert(vendors)
      .values({
        organizationId,
        code: parsed.data.code,
        name: parsed.data.name,
        displayName: parsed.data.displayName || null,
        vendorType: parsed.data.vendorType,
        defaultPaymentTermsDays: parsed.data.defaultPaymentTermsDays,
        currency: parsed.data.currency.toUpperCase(),
        is1099Vendor: parsed.data.is1099Vendor,
        tin: parsed.data.tin || null,
        w9OnFile: parsed.data.w9OnFile,
        notes: parsed.data.notes || null,
        isActive: parsed.data.isActive,
        addresses: parsed.data.addresses as Address[],
        contacts: parsed.data.contacts as Contact[],
      })
      .returning({ id: vendors.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "vendor.created",
      entityType: "vendor",
      entityId: row.id,
      metadata: {
        code: parsed.data.code,
        name: parsed.data.name,
        is1099: parsed.data.is1099Vendor,
      },
    });

    revalidatePath("/vendors");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Vendor code "${parsed.data.code}" already in use.` };
    }
    console.error("[vendors] createVendor failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateVendor(
  vendorId: string,
  input: VendorInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = VendorSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db
      .update(vendors)
      .set({
        code: parsed.data.code,
        name: parsed.data.name,
        displayName: parsed.data.displayName || null,
        vendorType: parsed.data.vendorType,
        defaultPaymentTermsDays: parsed.data.defaultPaymentTermsDays,
        currency: parsed.data.currency.toUpperCase(),
        is1099Vendor: parsed.data.is1099Vendor,
        tin: parsed.data.tin || null,
        w9OnFile: parsed.data.w9OnFile,
        notes: parsed.data.notes || null,
        isActive: parsed.data.isActive,
        addresses: parsed.data.addresses as Address[],
        contacts: parsed.data.contacts as Contact[],
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(vendors.id, vendorId), eq(vendors.organizationId, organizationId))
      );

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "vendor.updated",
      entityType: "vendor",
      entityId: vendorId,
      metadata: { code: parsed.data.code },
    });

    revalidatePath("/vendors");
    return { ok: true, id: vendorId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict." };
    }
    console.error("[vendors] updateVendor failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
