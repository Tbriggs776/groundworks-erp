import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apBills,
  apPaymentApplications,
  apPayments,
  arInvoices,
  arPaymentApplications,
  arPayments,
  customerType,
  customers,
  vendorType,
  vendors,
  type Address,
  type Contact,
  type Customer,
  type Vendor,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx, type Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound, rethrowUnique } from "@/lib/errors";
import {
  currency,
  flag,
  id,
  likePattern,
  nonNegativeAmount,
  optionalText,
  type Page,
  pagination,
  toPage,
} from "@/lib/schemas";

/**
 * CUSTOMERS + VENDORS. Codes are optional on input: when omitted we derive
 * one from the name (ACME-CORP, ACME-CORP-2, …) so neither people nor
 * agents have to invent identifiers.
 */

const AddressSchema = z.object({
  type: z.enum(["billing", "shipping", "remit", "mailing", "other"]),
  street1: z.string().trim(),
  street2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  zip: optionalText(20),
  country: optionalText(100),
});

const ContactSchema = z.object({
  name: z.string().trim().min(1),
  title: optionalText(100),
  email: z.email().optional().or(z.literal("")),
  phone: optionalText(50),
  isPrimary: z.boolean().optional(),
});

const PartyFields = {
  code: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe("Short unique code. Omit to derive one from the name."),
  name: z.string().trim().min(1).max(200),
  displayName: optionalText(100),
  email: z
    .email()
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null))
    .describe("Primary billing email."),
  phone: optionalText(50),
  defaultPaymentTermsDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe("Net terms in days (30 = Net 30). Defaults to 30."),
  currency: currency.optional(),
  notes: optionalText(),
  isActive: z.boolean().optional(),
  addresses: z.array(AddressSchema).optional(),
  contacts: z.array(ContactSchema).optional(),
};

export const CreateCustomerSchema = z.object({
  ...PartyFields,
  customerType: z.enum(customerType.enumValues).optional(),
  creditLimit: nonNegativeAmount.optional().nullable(),
  taxExempt: z.boolean().optional(),
  taxId: optionalText(50),
});
export type CreateCustomerInput = z.input<typeof CreateCustomerSchema>;
export const UpdateCustomerSchema = CreateCustomerSchema.partial().extend({ id });
export type UpdateCustomerInput = z.input<typeof UpdateCustomerSchema>;

export const CreateVendorSchema = z.object({
  ...PartyFields,
  vendorType: z.enum(vendorType.enumValues).optional(),
  is1099Vendor: z.boolean().optional(),
  tin: optionalText(20),
  w9OnFile: z.boolean().optional(),
});
export type CreateVendorInput = z.input<typeof CreateVendorSchema>;
export const UpdateVendorSchema = CreateVendorSchema.partial().extend({ id });
export type UpdateVendorInput = z.input<typeof UpdateVendorSchema>;

export const ListPartiesSchema = z.object({
  q: z.string().trim().optional().describe("Search code, name, or email."),
  includeInactive: flag.optional(),
  ...pagination,
});

/** "Acme Corp, LLC" → "ACME-CORP-LLC" (max 24 chars). */
export function codeFromName(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base || "PARTY";
}

async function uniqueCode(
  tx: Tx,
  table: typeof customers | typeof vendors,
  organizationId: string,
  name: string
): Promise<string> {
  const base = codeFromName(name);
  const rows = await tx
    .select({ code: table.code })
    .from(table)
    .where(and(eq(table.organizationId, organizationId), ilike(table.code, `${base}%`)));
  const taken = new Set(rows.map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export type CustomerRow = Customer & { openBalance: string };

// Correlations below name the outer table literally: Drizzle renders
// columns unqualified in single-table selects, which would silently bind
// `id` to the subquery's own table.

const customerOpenBalance = sql<string>`COALESCE((
  SELECT SUM(i.total_amount - COALESCE((
    SELECT SUM(a.amount + a.discount_amount)
      FROM ${arPaymentApplications} a
      JOIN ${arPayments} p ON p.id = a.payment_id
     WHERE a.invoice_id = i.id AND p.status = 'posted'
  ), 0))
    FROM ${arInvoices} i
   WHERE i.customer_id = "customers"."id" AND i.status IN ('open', 'paid')
), 0)::text`;

export async function listCustomers(
  ctx: Ctx,
  input: z.input<typeof ListPartiesSchema> = {}
): Promise<Page<CustomerRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list customers");
  const f = ListPartiesSchema.parse(input);
  const rows = await ctx.tx
    .select({ customer: customers, openBalance: customerOpenBalance })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, ctx.actor.organizationId),
        isNull(customers.deletedAt),
        f.includeInactive ? undefined : eq(customers.isActive, true),
        f.q
          ? or(
              ilike(customers.code, likePattern(f.q)),
              ilike(customers.name, likePattern(f.q)),
              ilike(customers.displayName, likePattern(f.q)),
              ilike(customers.email, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(asc(customers.name))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.customer, openBalance: r.openBalance })),
    f.limit,
    f.offset
  );
}

export async function getCustomer(ctx: Ctx, input: { id: string }): Promise<CustomerRow> {
  requirePermission(ctx.actor, "read", "viewer", "view customers");
  const customerId = id.parse(input.id);
  const [row] = await ctx.tx
    .select({ customer: customers, openBalance: customerOpenBalance })
    .from(customers)
    .where(
      and(eq(customers.id, customerId), eq(customers.organizationId, ctx.actor.organizationId))
    );
  if (!row) throw notFound("Customer");
  return { ...row.customer, openBalance: row.openBalance };
}

export async function createCustomer(ctx: Ctx, input: CreateCustomerInput): Promise<Customer> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create customers");
  const d = CreateCustomerSchema.parse(input);
  const org = ctx.actor.organizationId;
  const code = d.code || (await uniqueCode(ctx.tx, customers, org, d.name));
  let row: Customer;
  try {
    [row] = await ctx.tx
      .insert(customers)
      .values({
        organizationId: org,
        code,
        name: d.name,
        displayName: d.displayName,
        email: d.email ?? null,
        phone: d.phone,
        customerType: d.customerType ?? "commercial",
        defaultPaymentTermsDays: d.defaultPaymentTermsDays ?? 30,
        currency: d.currency ?? "USD",
        creditLimit: d.creditLimit ?? null,
        taxExempt: d.taxExempt ?? false,
        taxId: d.taxId,
        notes: d.notes,
        isActive: d.isActive ?? true,
        addresses: (d.addresses ?? []) as Address[],
        contacts: (d.contacts ?? []) as Contact[],
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `Customer code "${code}" is already in use.`);
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "customer.created",
      entityType: "customer",
      entityId: row.id,
      metadata: { code: row.code, name: row.name },
    },
    ctx.tx
  );
  return row;
}

export async function updateCustomer(ctx: Ctx, input: UpdateCustomerInput): Promise<Customer> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit customers");
  const d = UpdateCustomerSchema.parse(input);
  const before = await getCustomer(ctx, { id: d.id });
  let row: Customer;
  try {
    [row] = await ctx.tx
      .update(customers)
      .set({
        code: d.code || before.code,
        name: d.name ?? before.name,
        displayName: d.displayName !== undefined ? d.displayName : before.displayName,
        email: d.email !== undefined ? d.email : before.email,
        phone: d.phone !== undefined ? d.phone : before.phone,
        customerType: d.customerType ?? before.customerType,
        defaultPaymentTermsDays: d.defaultPaymentTermsDays ?? before.defaultPaymentTermsDays,
        currency: d.currency ?? before.currency,
        creditLimit: d.creditLimit !== undefined ? d.creditLimit : before.creditLimit,
        taxExempt: d.taxExempt ?? before.taxExempt,
        taxId: d.taxId !== undefined ? d.taxId : before.taxId,
        notes: d.notes !== undefined ? d.notes : before.notes,
        isActive: d.isActive ?? before.isActive,
        addresses: (d.addresses ?? before.addresses) as Address[],
        contacts: (d.contacts ?? before.contacts) as Contact[],
        updatedAt: sql`now()`,
      })
      .where(eq(customers.id, before.id))
      .returning();
  } catch (err) {
    rethrowUnique(err, `Customer code "${d.code}" is already in use.`);
  }
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "customer.updated",
      entityType: "customer",
      entityId: row.id,
      metadata: { code: row.code, changed: Object.keys(d).filter((k) => k !== "id") },
    },
    ctx.tx
  );
  return row;
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export type VendorRow = Vendor & { openBalance: string };

const vendorOpenBalance = sql<string>`COALESCE((
  SELECT SUM(b.total_amount - COALESCE((
    SELECT SUM(a.applied_amount + a.discount_amount)
      FROM ${apPaymentApplications} a
      JOIN ${apPayments} p ON p.id = a.payment_id
     WHERE a.bill_id = b.id AND p.status = 'posted'
  ), 0))
    FROM ${apBills} b
   WHERE b.vendor_id = "vendors"."id" AND b.status IN ('posted', 'paid')
), 0)::text`;

export async function listVendors(
  ctx: Ctx,
  input: z.input<typeof ListPartiesSchema> = {}
): Promise<Page<VendorRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list vendors");
  const f = ListPartiesSchema.parse(input);
  const rows = await ctx.tx
    .select({ vendor: vendors, openBalance: vendorOpenBalance })
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, ctx.actor.organizationId),
        isNull(vendors.deletedAt),
        f.includeInactive ? undefined : eq(vendors.isActive, true),
        f.q
          ? or(
              ilike(vendors.code, likePattern(f.q)),
              ilike(vendors.name, likePattern(f.q)),
              ilike(vendors.displayName, likePattern(f.q)),
              ilike(vendors.email, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(asc(vendors.name))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.vendor, openBalance: r.openBalance })),
    f.limit,
    f.offset
  );
}

export async function getVendor(ctx: Ctx, input: { id: string }): Promise<VendorRow> {
  requirePermission(ctx.actor, "read", "viewer", "view vendors");
  const vendorId = id.parse(input.id);
  const [row] = await ctx.tx
    .select({ vendor: vendors, openBalance: vendorOpenBalance })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.organizationId, ctx.actor.organizationId)));
  if (!row) throw notFound("Vendor");
  return { ...row.vendor, openBalance: row.openBalance };
}

export async function createVendor(ctx: Ctx, input: CreateVendorInput): Promise<Vendor> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create vendors");
  const d = CreateVendorSchema.parse(input);
  const org = ctx.actor.organizationId;
  const code = d.code || (await uniqueCode(ctx.tx, vendors, org, d.name));
  let row: Vendor;
  try {
    [row] = await ctx.tx
      .insert(vendors)
      .values({
        organizationId: org,
        code,
        name: d.name,
        displayName: d.displayName,
        email: d.email ?? null,
        phone: d.phone,
        vendorType: d.vendorType ?? "supplier",
        defaultPaymentTermsDays: d.defaultPaymentTermsDays ?? 30,
        currency: d.currency ?? "USD",
        is1099Vendor: d.is1099Vendor ?? false,
        tin: d.tin,
        w9OnFile: d.w9OnFile ?? false,
        notes: d.notes,
        isActive: d.isActive ?? true,
        addresses: (d.addresses ?? []) as Address[],
        contacts: (d.contacts ?? []) as Contact[],
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `Vendor code "${code}" is already in use.`);
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "vendor.created",
      entityType: "vendor",
      entityId: row.id,
      metadata: { code: row.code, name: row.name, is1099: row.is1099Vendor },
    },
    ctx.tx
  );
  return row;
}

export async function updateVendor(ctx: Ctx, input: UpdateVendorInput): Promise<Vendor> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit vendors");
  const d = UpdateVendorSchema.parse(input);
  const before = await getVendor(ctx, { id: d.id });
  let row: Vendor;
  try {
    [row] = await ctx.tx
      .update(vendors)
      .set({
        code: d.code || before.code,
        name: d.name ?? before.name,
        displayName: d.displayName !== undefined ? d.displayName : before.displayName,
        email: d.email !== undefined ? d.email : before.email,
        phone: d.phone !== undefined ? d.phone : before.phone,
        vendorType: d.vendorType ?? before.vendorType,
        defaultPaymentTermsDays: d.defaultPaymentTermsDays ?? before.defaultPaymentTermsDays,
        currency: d.currency ?? before.currency,
        is1099Vendor: d.is1099Vendor ?? before.is1099Vendor,
        tin: d.tin !== undefined ? d.tin : before.tin,
        w9OnFile: d.w9OnFile ?? before.w9OnFile,
        notes: d.notes !== undefined ? d.notes : before.notes,
        isActive: d.isActive ?? before.isActive,
        addresses: (d.addresses ?? before.addresses) as Address[],
        contacts: (d.contacts ?? before.contacts) as Contact[],
        updatedAt: sql`now()`,
      })
      .where(eq(vendors.id, before.id))
      .returning();
  } catch (err) {
    rethrowUnique(err, `Vendor code "${d.code}" is already in use.`);
  }
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "vendor.updated",
      entityType: "vendor",
      entityId: row.id,
      metadata: { code: row.code, changed: Object.keys(d).filter((k) => k !== "id") },
    },
    ctx.tx
  );
  return row;
}

/** Guard used by documents: the party exists in this org and is active. */
export async function requireActiveCustomer(ctx: Ctx, customerId: string): Promise<Customer> {
  const [c] = await ctx.tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, ctx.actor.organizationId)));
  if (!c) throw notFound("Customer");
  if (!c.isActive) throw new AppError("invalid_input", `Customer ${c.name} is inactive.`);
  return c;
}
