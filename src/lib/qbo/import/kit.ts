import { and, eq, sql } from "drizzle-orm";
import { organizations, qboIdMap, type QboCounts } from "@/lib/db/schema";
import type { Ctx } from "@/lib/actor";
import { toAppError } from "@/lib/errors";
import { ensureFiscalYearFor } from "@/lib/gl/fiscal-calendar";
import { PAGE_SIZE, type QboClient, type QboRecord } from "../client";

/**
 * What every import step works with: the company's context, the QuickBooks
 * client, the id map (QuickBooks id → Groundworks id), counts, notes for
 * the person to review, and the batch's deadline.
 */

export type Ref = { value?: string; name?: string } | undefined;

export class Kit {
  readonly notes: string[] = [];
  readonly counts: QboCounts;
  private cache = new Map<string, { localId: string | null; value: string | null } | null>();

  constructor(
    readonly ctx: Ctx,
    readonly client: QboClient,
    counts: QboCounts,
    readonly deadline: number
  ) {
    this.counts = structuredClone(counts);
  }

  private memo = new Map<string, Promise<unknown>>();

  /** Work done once per batch (lookups a step needs for every record). */
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key) as Promise<T>;
  }

  get org() {
    return this.ctx.actor.organizationId;
  }

  private progressed = false;

  /** Past the deadline, once the batch has done something (so every batch moves forward). */
  timeUp() {
    return this.progressed && Date.now() > this.deadline;
  }

  note(message: string) {
    this.notes.push(message);
  }

  count(step: string, what: "imported" | "skipped") {
    this.progressed = true;
    const c = (this.counts[step] ??= { imported: 0, skipped: 0 });
    c[what] += 1;
  }

  private key(entity: string, qboId: string) {
    return `${entity}:${qboId}`;
  }

  /** Load an entity's whole map in one query (lists the steps look up often). */
  async preload(entity: string) {
    const rows = await this.ctx.tx
      .select({ qboId: qboIdMap.qboId, localId: qboIdMap.localId, value: qboIdMap.value })
      .from(qboIdMap)
      .where(and(eq(qboIdMap.organizationId, this.org), eq(qboIdMap.entity, entity)));
    for (const r of rows) this.cache.set(this.key(entity, r.qboId), { localId: r.localId, value: r.value });
  }

  async mapped(entity: string, qboId: string) {
    const k = this.key(entity, qboId);
    if (!this.cache.has(k)) {
      const [r] = await this.ctx.tx
        .select({ localId: qboIdMap.localId, value: qboIdMap.value })
        .from(qboIdMap)
        .where(and(eq(qboIdMap.organizationId, this.org), eq(qboIdMap.entity, entity), eq(qboIdMap.qboId, qboId)));
      this.cache.set(k, r ?? null);
    }
    return this.cache.get(k) ?? null;
  }

  /** The Groundworks id a QuickBooks reference became (null when it wasn't imported). */
  async local(entity: string, ref: Ref): Promise<string | null> {
    if (!ref?.value) return null;
    return (await this.mapped(entity, ref.value))?.localId ?? null;
  }

  async remember(entity: string, qboId: string, localId: string | null, value: string | null = null) {
    await this.ctx.tx.insert(qboIdMap).values({ organizationId: this.org, entity, qboId, localId, value }).onConflictDoNothing();
    this.cache.set(this.key(entity, qboId), { localId, value });
  }

  private years = new Set<number>();

  /** Make sure the fiscal year holding `date` exists, on the company's calendar. */
  async year(date: string) {
    const startMonth = await this.once("fy-start", async () => {
      const [o] = await this.ctx.tx.select({ m: organizations.fiscalYearStartMonth }).from(organizations).where(eq(organizations.id, this.org));
      return o.m;
    });
    const [y, m] = date.split("-").map(Number);
    const startYear = m >= startMonth ? y : y - 1;
    if (this.years.has(startYear)) return;
    await ensureFiscalYearFor(this.ctx.tx, this.org, startMonth, date);
    this.years.add(startYear);
  }
}

/** A record the app refuses comes across noted and skipped, never stopping the import. */
export async function attempt(kit: Kit, what: string, fn: () => Promise<"imported" | "skipped" | void>): Promise<"imported" | "skipped"> {
  try {
    await kit.ctx.tx.execute(sql`SAVEPOINT qbo_record`);
    const r = await fn();
    await kit.ctx.tx.execute(sql`RELEASE SAVEPOINT qbo_record`);
    return r ?? "imported";
  } catch (err) {
    await kit.ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT qbo_record`);
    kit.note(`${what} didn't come across: ${toAppError(err).message}`);
    return "skipped";
  }
}

export type Step = {
  key: string;
  label: string;
  /** Import from `position` (1-based) until done or out of time; returns where to resume. */
  run: (kit: Kit, position: number) => Promise<{ done: boolean; position: number }>;
};

/**
 * The usual list or transaction step: page through an entity, import each
 * record not already mapped, then make sure nothing slipped past.
 */
export function pagedStep(opts: {
  key: string;
  label: string;
  entity: string;
  where?: string;
  preload?: string[];
  importOne: (kit: Kit, r: QboRecord) => Promise<"imported" | "skipped">;
}): Step {
  const seen = (kit: Kit) => (kit.counts[opts.key]?.imported ?? 0) + (kit.counts[opts.key]?.skipped ?? 0);
  async function scan(kit: Kit, position: number): Promise<{ done: boolean; position: number }> {
    let pos = position;
    for (;;) {
      const rows = await kit.client.page(opts.entity, pos, opts.where);
      for (const [i, r] of rows.entries()) {
        if (kit.timeUp()) return { done: false, position: pos + i };
        if (await kit.mapped(opts.entity, r.Id)) continue;
        kit.count(opts.key, await opts.importOne(kit, r));
      }
      if (rows.length < PAGE_SIZE) return { done: true, position: 1 };
      pos += rows.length;
    }
  }
  return {
    key: opts.key,
    label: opts.label,
    async run(kit, position) {
      for (const e of [opts.entity, ...(opts.preload ?? [])]) await kit.preload(e);
      const first = await scan(kit, position);
      if (!first.done) return first;
      // Everything QuickBooks has should now be mapped; if not, scan once more.
      const total = await kit.client.count(opts.entity, opts.where);
      if (seen(kit) < total) {
        const again = await scan(kit, 1);
        if (!again.done) return again;
        if (seen(kit) < total) {
          kit.note(`${opts.label}: QuickBooks reports ${total}, but ${seen(kit)} came across. Run the import again to pick up the rest.`);
        }
      }
      return { done: true, position: 1 };
    },
  };
}
