"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { memberships, organizations, profiles } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { seedOrganizationDefaults } from "@/lib/seed/org-defaults";
import { randomSuffix, slugify } from "@/lib/slug";

const CreateOrgSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  seedContractorCoa: z
    .union([z.literal("on"), z.literal("off"), z.null(), z.undefined()])
    .transform((v) => v === "on"),
});

export type CreateOrgState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

/**
 * Create the user's first organization, membership (owner), org defaults
 * (system dimensions, source codes, number series, optional CoA template),
 * and audit row — atomically. Redirects to /dashboard on success.
 */
export async function createOrganization(
  _prev: CreateOrgState,
  formData: FormData
): Promise<CreateOrgState> {
  const user = await requireUser();

  const parsed = CreateOrgSchema.safeParse({
    name: formData.get("name"),
    fiscalYearStartMonth: formData.get("fiscalYearStartMonth"),
    seedContractorCoa: formData.get("seedContractorCoa"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Please fix the errors below.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { name, fiscalYearStartMonth, seedContractorCoa } = parsed.data;
  const baseSlug = slugify(name) || "org";

  try {
    await db.transaction(async (tx) => {
      // Defensive profile insert — the signup trigger should have created
      // this row already, but keep the onboarding atomic in case of race.
      await tx
        .insert(profiles)
        .values({ id: user.id, email: user.email })
        .onConflictDoNothing();

      // Retry on slug collision.
      let orgId: string | undefined;
      let slug = baseSlug;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const [row] = await tx
            .insert(organizations)
            .values({ name, slug, fiscalYearStartMonth })
            .returning({ id: organizations.id });
          orgId = row.id;
          break;
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            slug = `${baseSlug}-${randomSuffix()}`;
            continue;
          }
          throw err;
        }
      }
      if (!orgId) {
        throw new Error(
          "Could not assign a unique slug for the organization."
        );
      }

      await tx.insert(memberships).values({
        organizationId: orgId,
        userId: user.id,
        role: "owner",
      });

      await seedOrganizationDefaults(tx, orgId, {
        includeContractorCoa: seedContractorCoa,
      });

      await writeAudit(
        {
          organizationId: orgId,
          actorId: user.id,
          event: "organization.created",
          entityType: "organization",
          entityId: orgId,
          metadata: {
            name,
            slug,
            fiscalYearStartMonth,
            seededCoa: seedContractorCoa,
          },
        },
        tx
      );
    });
  } catch (err) {
    console.error("[onboarding] createOrganization failed:", err);
    return {
      status: "error",
      message:
        "We couldn't create your organization. Try again in a moment — if it keeps failing, contact support.",
    };
  }

  redirect("/dashboard");
}
