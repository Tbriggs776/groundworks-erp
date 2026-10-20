import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { companyProfiles, organizations, type CompanyAddress, type CompanyProfile } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { optionalText } from "@/lib/schemas";

/**
 * The company profile printed on PDFs: legal name, address, contact
 * details, footer message, and logo. Admins edit it; everyone can read it.
 */

export const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg"] as const;

const AddressSchema = z.object({
  street1: optionalText(200),
  street2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  zip: optionalText(20),
  country: optionalText(100),
});

export const UpdateCompanyProfileSchema = z.object({
  legalName: optionalText(200).describe("Name printed on documents. Defaults to the company's name."),
  address: AddressSchema.optional(),
  phone: optionalText(50),
  email: z
    .union([z.email().max(200), z.literal("")])
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  website: optionalText(200),
  taxId: optionalText(100).describe("Tax or registration number, printed under the address."),
  documentFooter: optionalText(1000).describe("Printed at the bottom of every PDF: payment instructions, a thank-you."),
});
export type UpdateCompanyProfileInput = z.input<typeof UpdateCompanyProfileSchema>;

export const SetCompanyLogoSchema = z.object({
  contentType: z.enum(LOGO_TYPES),
  base64: z.string().min(1).describe("The image file, base64 encoded. PNG or JPEG, 512 KB at most."),
});

/** What callers see: the profile without the logo bytes. */
export type CompanyProfileView = Omit<CompanyProfile, "logoData"> & {
  companyName: string;
  displayName: string;
  hasLogo: boolean;
  logoBytes: number;
};

export async function loadCompanyProfile(ctx: Ctx): Promise<{ profile: CompanyProfile | null; companyName: string }> {
  const [org] = await ctx.tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.organizationId));
  const [profile] = await ctx.tx
    .select()
    .from(companyProfiles)
    .where(eq(companyProfiles.organizationId, ctx.actor.organizationId));
  return { profile: profile ?? null, companyName: org?.name ?? "" };
}

function view(profile: CompanyProfile | null, companyName: string, organizationId: string): CompanyProfileView {
  const base: CompanyProfile = profile ?? {
    id: "",
    organizationId,
    legalName: null,
    address: {},
    phone: null,
    email: null,
    website: null,
    taxId: null,
    documentFooter: null,
    logoData: null,
    logoContentType: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };
  const { logoData, ...rest } = base;
  return {
    ...rest,
    companyName,
    displayName: base.legalName || companyName,
    hasLogo: Boolean(logoData),
    logoBytes: logoData ? Buffer.from(logoData, "base64").length : 0,
  };
}

export async function getCompanyProfile(ctx: Ctx): Promise<CompanyProfileView> {
  requirePermission(ctx.actor, "read", "viewer", "view the company profile");
  const { profile, companyName } = await loadCompanyProfile(ctx);
  return view(profile, companyName, ctx.actor.organizationId);
}

async function upsert(ctx: Ctx, values: Partial<Omit<CompanyProfile, "id" | "organizationId">>) {
  await ctx.tx
    .insert(companyProfiles)
    .values({ organizationId: ctx.actor.organizationId, ...values })
    .onConflictDoUpdate({ target: companyProfiles.organizationId, set: { ...values, updatedAt: sql`now()` } });
}

export async function updateCompanyProfile(ctx: Ctx, input: UpdateCompanyProfileInput): Promise<CompanyProfileView> {
  requirePermission(ctx.actor, "admin", "admin", "edit the company profile");
  const d = UpdateCompanyProfileSchema.parse(input);
  const before = await getCompanyProfile(ctx);
  const values = {
    ...(d.legalName !== undefined ? { legalName: d.legalName } : {}),
    ...(d.address !== undefined ? { address: compactAddress(d.address) } : {}),
    ...(d.phone !== undefined ? { phone: d.phone } : {}),
    ...(d.email !== undefined ? { email: d.email } : {}),
    ...(d.website !== undefined ? { website: d.website } : {}),
    ...(d.taxId !== undefined ? { taxId: d.taxId } : {}),
    ...(d.documentFooter !== undefined ? { documentFooter: d.documentFooter } : {}),
  };
  await upsert(ctx, values);
  const after = await getCompanyProfile(ctx);
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "settings.company_profile.updated",
      entityType: "organization",
      entityId: ctx.actor.organizationId,
      metadata: { changed: Object.keys(values), before: pick(before, Object.keys(values)), after: pick(after, Object.keys(values)) },
    },
    ctx.tx
  );
  return after;
}

/** Keep only the address parts that are filled in. */
function compactAddress(a: z.output<typeof AddressSchema>): CompanyAddress {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v === "string" && v)) as CompanyAddress;
}

function pick(v: CompanyProfileView, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, v[k as keyof CompanyProfileView]]));
}

/** PNG and JPEG start with fixed bytes; anything else isn't the image it claims to be. */
function sniff(bytes: Buffer): (typeof LOGO_TYPES)[number] | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export async function setCompanyLogo(ctx: Ctx, input: z.input<typeof SetCompanyLogoSchema>): Promise<CompanyProfileView> {
  requirePermission(ctx.actor, "admin", "admin", "change the company logo");
  const d = SetCompanyLogoSchema.parse(input);
  const bytes = Buffer.from(d.base64, "base64");
  if (bytes.length === 0) throw new AppError("invalid_input", "The logo is empty.");
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new AppError("invalid_input", `The logo is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${LOGO_MAX_BYTES / 1024} KB.`);
  }
  const actual = sniff(bytes);
  if (!actual) throw new AppError("invalid_input", "The logo must be a PNG or JPEG image.");
  if (actual !== d.contentType) throw new AppError("invalid_input", `The file is a ${actual}, not a ${d.contentType}.`);
  await upsert(ctx, { logoData: bytes.toString("base64"), logoContentType: actual });
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "settings.company_logo.updated",
      entityType: "organization",
      entityId: ctx.actor.organizationId,
      metadata: { contentType: actual, bytes: bytes.length },
    },
    ctx.tx
  );
  return getCompanyProfile(ctx);
}

export async function removeCompanyLogo(ctx: Ctx): Promise<CompanyProfileView> {
  requirePermission(ctx.actor, "admin", "admin", "remove the company logo");
  await upsert(ctx, { logoData: null, logoContentType: null });
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "settings.company_logo.removed",
      entityType: "organization",
      entityId: ctx.actor.organizationId,
      metadata: {},
    },
    ctx.tx
  );
  return getCompanyProfile(ctx);
}

/** The logo as a data URL, for the settings page preview. */
export async function companyLogoDataUrl(ctx: Ctx): Promise<string | null> {
  requirePermission(ctx.actor, "read", "viewer", "view the company profile");
  const { profile } = await loadCompanyProfile(ctx);
  return profile?.logoData ? `data:${profile.logoContentType};base64,${profile.logoData}` : null;
}
