import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";

/** Company-wide sales settings. */

export const UpdateSalesSettingsSchema = z.object({
  autoApplyCredits: z
    .boolean()
    .describe("Credit memos and overpayments pay down open invoices automatically, oldest first, as documents post."),
});

export async function getSalesSettings(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "view sales settings");
  const [org] = await ctx.tx
    .select({ autoApplyCredits: organizations.autoApplyCredits })
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.organizationId));
  return org;
}

export async function updateSalesSettings(ctx: Ctx, input: z.input<typeof UpdateSalesSettingsSchema>) {
  requirePermission(ctx.actor, "admin", "admin", "change sales settings");
  const d = UpdateSalesSettingsSchema.parse(input);
  const before = await getSalesSettings(ctx);
  await ctx.tx
    .update(organizations)
    .set({ autoApplyCredits: d.autoApplyCredits, updatedAt: sql`now()` })
    .where(eq(organizations.id, ctx.actor.organizationId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "settings.sales.updated",
      entityType: "organization",
      entityId: ctx.actor.organizationId,
      metadata: { before, after: d },
    },
    ctx.tx
  );
  return getSalesSettings(ctx);
}
