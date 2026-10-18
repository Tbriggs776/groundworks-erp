import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  dimensionValues,
  dimensions,
  fiscalPeriods,
  organizations,
} from "@/lib/db/schema";
import { requirePermission, type Actor, type Ctx } from "@/lib/actor";
import { isoDate } from "@/lib/schemas";

/**
 * Reference data an agent needs before it can write anything useful:
 * who am I, which org, which periods are open, which classes / locations
 * exist. Read-only.
 */

export async function whoami(ctx: Ctx): Promise<{
  organization: { id: string; name: string; baseCurrency: string; fiscalYearStartMonth: number };
  actor: Pick<Actor, "kind" | "role" | "scopes" | "agentName" | "maxPostAmount" | "channel">;
  guidance: string[];
}> {
  const [org] = await ctx.tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.organizationId));
  const a = ctx.actor;
  const guidance: string[] = [];
  if (!a.scopes.includes("write")) guidance.push("Read-only: you can look but not create anything.");
  else if (!a.scopes.includes("post"))
    guidance.push(
      "Draft mode: documents you create stay drafts until a human posts them from the review queue. Don't pass post=true."
    );
  if (a.maxPostAmount)
    guidance.push(`Posting limit: documents over ${a.maxPostAmount} are left as drafts for review.`);
  return {
    organization: {
      id: org.id,
      name: org.name,
      baseCurrency: org.baseCurrency,
      fiscalYearStartMonth: org.fiscalYearStartMonth,
    },
    actor: {
      kind: a.kind,
      role: a.role,
      scopes: a.scopes,
      agentName: a.agentName,
      maxPostAmount: a.maxPostAmount,
      channel: a.channel,
    },
    guidance,
  };
}

export const ListPeriodsSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function listPeriods(ctx: Ctx, input: z.input<typeof ListPeriodsSchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "list fiscal periods");
  const f = ListPeriodsSchema.parse(input);
  const rows = await ctx.tx
    .select({
      id: fiscalPeriods.id,
      periodCode: fiscalPeriods.periodCode,
      startDate: fiscalPeriods.startDate,
      endDate: fiscalPeriods.endDate,
      status: fiscalPeriods.status,
    })
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.organizationId, ctx.actor.organizationId))
    .orderBy(asc(fiscalPeriods.startDate));
  return rows.filter((p) => (!f.from || p.endDate >= f.from) && (!f.to || p.startDate <= f.to));
}

export async function listDimensions(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "list classes and locations");
  const org = ctx.actor.organizationId;
  const dims = await ctx.tx
    .select({ id: dimensions.id, code: dimensions.code, name: dimensions.name })
    .from(dimensions)
    .where(and(eq(dimensions.organizationId, org), eq(dimensions.isBlocked, false), isNull(dimensions.deletedAt)))
    .orderBy(asc(dimensions.sortOrder));
  const values = await ctx.tx
    .select({
      id: dimensionValues.id,
      dimensionId: dimensionValues.dimensionId,
      code: dimensionValues.code,
      name: dimensionValues.name,
    })
    .from(dimensionValues)
    .where(
      and(
        eq(dimensionValues.organizationId, org),
        eq(dimensionValues.isBlocked, false),
        isNull(dimensionValues.deletedAt)
      )
    )
    .orderBy(asc(dimensionValues.code));
  return dims.map((d) => ({ ...d, values: values.filter((v) => v.dimensionId === d.id) }));
}
