import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { organizations } from "./identity";

/**
 * COMPANY PROFILE — what customers see on PDFs: legal name, address,
 * contact details, a footer message, and the logo. One row per company,
 * created on first save. The logo is small (≤ 512 KB, PNG or JPEG) and
 * kept here as base64, so documents render without a storage service.
 */

export type CompanyAddress = {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
};

export const companyProfiles = pgTable(
  "company_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Defaults to the company's name when empty. */
    legalName: text("legal_name"),
    address: jsonb("address").$type<CompanyAddress>().notNull().default({}),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    /** Tax or registration number, printed under the address when set. */
    taxId: text("tax_id"),
    /** Printed at the bottom of every document (payment instructions, thanks). */
    documentFooter: text("document_footer"),
    logoData: text("logo_data"),
    logoContentType: text("logo_content_type"),
    ...timestamps,
  },
  (t) => [uniqueIndex("company_profiles_org_key").on(t.organizationId)]
);

export type CompanyProfile = typeof companyProfiles.$inferSelect;
