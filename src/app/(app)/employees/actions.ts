"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  employees,
  memberships,
  type Address,
} from "@/lib/db/schema";
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

const EmployeeSchema = z.object({
  code: z.string().trim().min(1).max(32),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  displayName: z.string().trim().max(100).optional().or(z.literal("")),
  userId: z.string().uuid().optional().nullable(),
  classification: z.enum([
    "salary",
    "hourly",
    "union",
    "contractor_1099",
    "owner_officer",
  ]),
  defaultRate: z.string().optional().or(z.literal("")),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  ssnLast4: z
    .string()
    .regex(/^\d{4}$/, "Must be exactly 4 digits.")
    .optional()
    .or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().default(true),
  addresses: z.array(AddressSchema).default([]),
});

export type EmployeeInput = z.input<typeof EmployeeSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Validate that `userId` (if provided) references a profile that holds an
 * ACTIVE membership in this org. Prevents linking to someone who was
 * never really "in" the org — a safety net against stale IDs in form
 * submissions.
 */
async function assertUserIsMember(
  organizationId: string,
  userId: string | null | undefined
): Promise<string | null> {
  if (!userId) return null;
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, userId),
        eq(memberships.isActive, true)
      )
    );
  if (!m) return "Linked user is not an active member of this organization.";
  return null;
}

export async function createEmployee(input: EmployeeInput): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = EmployeeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const memberErr = await assertUserIsMember(organizationId, parsed.data.userId);
  if (memberErr) return { ok: false, error: memberErr };

  try {
    const [row] = await db
      .insert(employees)
      .values({
        organizationId,
        code: parsed.data.code,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        displayName: parsed.data.displayName || null,
        userId: parsed.data.userId || null,
        classification: parsed.data.classification,
        defaultRate: parsed.data.defaultRate || null,
        hireDate: parsed.data.hireDate || null,
        terminationDate: parsed.data.terminationDate || null,
        email: parsed.data.email || null,
        phone: parsed.data.phone || null,
        ssnLast4: parsed.data.ssnLast4 || null,
        notes: parsed.data.notes || null,
        isActive: parsed.data.isActive,
        addresses: parsed.data.addresses as Address[],
      })
      .returning({ id: employees.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "employee.created",
      entityType: "employee",
      entityId: row.id,
      metadata: {
        code: parsed.data.code,
        name: `${parsed.data.firstName} ${parsed.data.lastName}`,
        classification: parsed.data.classification,
        linkedUser: parsed.data.userId ?? null,
      },
    });

    revalidatePath("/employees");
    return { ok: true, id: row.id };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      const msg = (err as Error).message;
      if (msg.includes("employees_org_user_key")) {
        return {
          ok: false,
          error: "This user is already linked to another employee record.",
        };
      }
      return {
        ok: false,
        error: `Employee code "${parsed.data.code}" already in use.`,
      };
    }
    console.error("[employees] createEmployee failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateEmployee(
  employeeId: string,
  input: EmployeeInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = EmployeeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const memberErr = await assertUserIsMember(organizationId, parsed.data.userId);
  if (memberErr) return { ok: false, error: memberErr };

  try {
    await db
      .update(employees)
      .set({
        code: parsed.data.code,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        displayName: parsed.data.displayName || null,
        userId: parsed.data.userId || null,
        classification: parsed.data.classification,
        defaultRate: parsed.data.defaultRate || null,
        hireDate: parsed.data.hireDate || null,
        terminationDate: parsed.data.terminationDate || null,
        email: parsed.data.email || null,
        phone: parsed.data.phone || null,
        ssnLast4: parsed.data.ssnLast4 || null,
        notes: parsed.data.notes || null,
        isActive: parsed.data.isActive,
        addresses: parsed.data.addresses as Address[],
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(employees.id, employeeId),
          eq(employees.organizationId, organizationId)
        )
      );

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "employee.updated",
      entityType: "employee",
      entityId: employeeId,
      metadata: { code: parsed.data.code },
    });

    revalidatePath("/employees");
    return { ok: true, id: employeeId };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      const msg = (err as Error).message;
      if (msg.includes("employees_org_user_key")) {
        return {
          ok: false,
          error: "This user is already linked to another employee record.",
        };
      }
      return { ok: false, error: "Code conflict." };
    }
    console.error("[employees] updateEmployee failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
