import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { qboConnections, qboIdMap, qboImports, type QboImport } from "@/lib/db/schema";
import { auditFields, requirePermission, requireWorkspaceRole, type Ctx, type WsCtx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { flushRecosting, holdRecosting } from "@/lib/inventory/engine";
import { seal, unseal } from "@/lib/security/crypto";
import { createCompany } from "@/lib/workspace/service";
import { QboClient } from "./client";
import { qboConfig } from "./config";
import { accountsStep } from "./import/accounts";
import { journalEntriesStep } from "./import/journals";
import { clearingStep } from "./import/clearing";
import { finishStep } from "./import/finish";
import { Kit, type Step } from "./import/kit";
import { estimatesStep, purchaseOrdersStep } from "./import/orders";
import { stockStep } from "./import/stock";
import { auditStep, classesStep, companyStep, customersStep, departmentsStep, itemsStep, termsStep, vendorsStep } from "./import/lists";
import { billPaymentsStep, customerPaymentsStep, depositsStep, paymentsFromDepositsStep } from "./import/payments";
import { billsStep, creditCardPaymentsStep, purchasesStep, transfersStep, vendorCreditsStep } from "./import/purchases";
import { creditMemosStep, invoicesStep, refundReceiptsStep, salesReceiptsStep } from "./import/sales";
import { paymentMethodsStep, taxAgenciesStep, taxCodesStep, taxRatesStep } from "./import/tax";
import { clearWatch, clearWatchIn, readInterrupted, startWatch, STOPS_TO_SKIP } from "./import/watch";
import { exchangeCode, revokeToken } from "./oauth";

/**
 * QUICKBOOKS IMPORT. Importing makes a new company in the workspace, keeps
 * its QuickBooks connection, and brings the books across in steps. Each
 * batch runs in one transaction until its time is up and records where to
 * pick up, so the page can keep calling for the next batch and a failure
 * loses nothing (the next batch repeats the failed one). Only people run
 * imports (admins and owners); agents can read the progress.
 */

/** In dependency order: lists, then purchases and sales, then what pays them, then marks. */
export const STEPS: Step[] = [
  companyStep,
  accountsStep,
  termsStep,
  classesStep,
  departmentsStep,
  paymentMethodsStep,
  taxAgenciesStep,
  taxRatesStep,
  taxCodesStep,
  customersStep,
  vendorsStep,
  itemsStep,
  estimatesStep,
  purchaseOrdersStep,
  billsStep,
  vendorCreditsStep,
  purchasesStep,
  transfersStep,
  creditCardPaymentsStep,
  invoicesStep,
  salesReceiptsStep,
  creditMemosStep,
  refundReceiptsStep,
  customerPaymentsStep,
  billPaymentsStep,
  depositsStep,
  paymentsFromDepositsStep,
  journalEntriesStep,
  clearingStep,
  stockStep,
  finishStep,
];

/**
 * Notes kept for the person. A big company writes thousands; past this the
 * rest are dropped, so the page also lists every skipped record from the id
 * map (`skipped` in the view), which is complete whatever the notes hold.
 */
const MAX_NOTES = 5000;

// Default batch budget: no new record starts after this. The page sets
// maxDuration=300, so the record in flight, flushRecosting, and the status
// write have minutes to finish and commit before Vercel kills the function.
// The page's action asks for less (BATCH_MS), so progress is saved often.
/** How long a batch can run before the platform kills it (the page's maxDuration). */
const BATCH_LIMIT_SECONDS = 300;

export const RunBatchSchema = z.object({ budgetMs: z.number().int().min(1).max(60_000).default(50_000) });

/** QuickBooks' company name, read with a fresh token before the company exists here. */
async function companyName(realmId: string, accessToken: string): Promise<string> {
  const res = await fetch(`${qboConfig().apiBase}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const json = (await res.json().catch(() => null)) as { CompanyInfo?: { CompanyName?: string } } | null;
  const name = json?.CompanyInfo?.CompanyName?.trim();
  if (!res.ok || !name) throw new AppError("upstream_error", "QuickBooks didn't return the company's details. Try the import again.");
  return name.slice(0, 100);
}

/** After Intuit's sign-in: a new company, connected, with its import ready to run. */
export async function beginImport(ctx: WsCtx, input: { code: string; realmId: string }): Promise<{ organizationId: string }> {
  requireWorkspaceRole(ctx.actor, "admin", "import a company from QuickBooks");
  const tokens = await exchangeCode(input.code);
  const name = await companyName(input.realmId, tokens.accessToken);
  const { id: organizationId } = await createCompany(ctx, { name, seedDefaultCoa: true });
  await ctx.tx.insert(qboConnections).values({
    organizationId,
    realmId: input.realmId,
    environment: qboConfig().environment,
    companyName: name,
    accessToken: seal(tokens.accessToken),
    refreshToken: seal(tokens.refreshToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    connectedBy: ctx.actor.userId,
  });
  await ctx.tx.insert(qboImports).values({ organizationId, cursor: { step: STEPS[0].key, position: 1 }, startedBy: ctx.actor.userId });
  await writeAudit(
    {
      organizationId,
      actorId: ctx.actor.userId,
      requestId: ctx.actor.requestId,
      ipAddress: ctx.actor.ipAddress,
      userAgent: ctx.actor.userAgent,
      event: "qbo.connected",
      entityType: "organization",
      entityId: organizationId,
      metadata: { realmId: input.realmId, companyName: name, environment: qboConfig().environment },
    },
    ctx.tx
  );
  return { organizationId };
}

/** Sign in to QuickBooks again for a company whose connection expired or was cut. */
export async function reconnect(ctx: Ctx, input: { code: string; realmId: string }): Promise<void> {
  requireHuman(ctx, "reconnect QuickBooks");
  const conn = await loadConnection(ctx);
  if (conn.realmId !== input.realmId) {
    throw new AppError("invalid_input", `That's a different QuickBooks company. Sign in to ${conn.companyName ?? "the one this company was imported from"}.`);
  }
  const t = await exchangeCode(input.code);
  await ctx.tx
    .update(qboConnections)
    .set({
      accessToken: seal(t.accessToken),
      refreshToken: seal(t.refreshToken),
      accessExpiresAt: t.accessExpiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
      disconnectedAt: null,
      connectedBy: ctx.actor.userId,
      connectedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(qboConnections.id, conn.id));
  await audit(ctx, "qbo.reconnected", { realmId: conn.realmId });
}

export function requireHuman(ctx: Ctx, action: string) {
  requirePermission(ctx.actor, "admin", "admin", action);
  if (ctx.actor.kind !== "user") throw new AppError("forbidden", `Only people can ${action}.`);
}

export async function loadConnection(ctx: Ctx) {
  const [conn] = await ctx.tx.select().from(qboConnections).where(eq(qboConnections.organizationId, ctx.actor.organizationId));
  if (!conn) throw new AppError("not_found", "This company isn't connected to QuickBooks.");
  return conn;
}

export async function latestImport(ctx: Ctx, lock: boolean): Promise<QboImport | null> {
  const q = ctx.tx
    .select()
    .from(qboImports)
    .where(eq(qboImports.organizationId, ctx.actor.organizationId))
    .orderBy(desc(qboImports.startedAt))
    .limit(1);
  const [imp] = lock ? await q.for("update", { skipLocked: true }) : await q;
  return imp ?? null;
}

const audit = (ctx: Ctx, event: string, metadata: Record<string, unknown>) =>
  writeAudit(
    { organizationId: ctx.actor.organizationId, ...auditFields(ctx.actor), event, entityType: "organization", entityId: ctx.actor.organizationId, metadata },
    ctx.tx
  );

/** Run the import until its time is up; returns where it stands. */
export async function runImportBatch(ctx: Ctx, input: z.input<typeof RunBatchSchema> = {}): Promise<ImportView> {
  const t0 = Date.now();
  const log = (msg: string) => console.log(`[qbo.import] +${Date.now() - t0}ms ${msg}`);
  log("batch start");
  requireHuman(ctx, "run the QuickBooks import");
  const { budgetMs } = RunBatchSchema.parse(input);
  log("latestImport");
  const imp = await latestImport(ctx, true);
  if (!imp) {
    log("row locked (SKIP LOCKED returned nothing); yielding to the other batch");
    return (await getImportView(ctx)) ?? notImported();
  }
  if (imp.status === "done") return (await getImportView(ctx))!;
  // The last batch's black box (./import/watch.ts): if it's still here, the
  // platform killed that batch before it could commit.
  const watch = await startWatch(ctx.actor.organizationId, imp.cursor.step);
  if (watch.stopped) log(`the last batch was stopped before it saved (${watch.suspect ? `${watch.suspect.label}, ${watch.suspect.stops} in a row` : "between records"})`);
  // Any single statement that runs longer than 25s aborts: a pathological
  // record (slow trigger, legacy data) can't eat the whole batch budget. The
  // savepoint around each record rolls it back and marks it skipped, so the
  // import moves on instead of looping on the same record forever.
  await ctx.tx.execute(sql`SET LOCAL statement_timeout = '25000'`);
  log("statement_timeout set to 25s");
  log(`loadConnection (realm=${imp.cursor.step})`);
  const conn = await loadConnection(ctx);
  if (!conn.refreshToken) throw new AppError("invalid_state", "QuickBooks is disconnected. Reconnect it to continue the import.");
  log(`starting at step=${imp.cursor.step} position=${imp.cursor.position}`);
  const kit = new Kit(ctx, new QboClient(conn), imp.counts, Date.now() + budgetMs);
  // Each inventory item is recosted once, at the end of the batch.
  holdRecosting(ctx);
  // A record that keeps getting the batch killed is skipped, so it can't
  // hold up the import forever; the person enters it by hand.
  const suspect = watch.suspect;
  if (suspect && suspect.stops >= STOPS_TO_SKIP && !(await kit.mapped(suspect.entity, suspect.qboId))) {
    log(`skipping ${suspect.entity} id=${suspect.qboId}: stopped ${suspect.stops} batches`);
    await kit.remember(suspect.entity, suspect.qboId, null, "skipped");
    kit.count(suspect.step, "skipped");
    kit.note(`${suspect.label} stopped the import ${suspect.stops} times before it could be saved, so it was skipped. Enter it by hand.`);
  }
  // A step this version doesn't know was saved by a newer one (a page open
  // from before a deploy): stop, never start the import over from the top.
  let index = STEPS.findIndex((s) => s.key === imp.cursor.step);
  if (index < 0) throw new AppError("invalid_state", "This page is out of date. Reload it, then continue the import.");
  let position = imp.cursor.position;
  while (index < STEPS.length) {
    kit.step = STEPS[index].key;
    log(`run step=${STEPS[index].key} position=${position}`);
    const r = await STEPS[index].run(kit, position);
    if (!r.done) {
      position = r.position;
      log(`step=${STEPS[index].key} paused at position=${position}`);
      break;
    }
    log(`step=${STEPS[index].key} done`);
    await auditStep(kit, STEPS[index].key);
    index += 1;
    position = 1;
    if (kit.timeUp()) break;
  }
  if (kit.noCustomerLines > 0) {
    kit.note(`Deposits: ${kit.noCustomerLines} lines (${kit.noCustomer.toFixed(2)}) went to Accounts Receivable without a customer, so they can't pay an invoice here. Check how they were entered in QuickBooks.`);
  }
  log("flushRecosting");
  await flushRecosting(ctx);
  log("writing status");
  await clearWatchIn(ctx);
  const done = index >= STEPS.length;
  await ctx.tx
    .update(qboImports)
    .set({
      status: done ? "done" : "running",
      cursor: done ? { step: "done", position: 1 } : { step: STEPS[index].key, position },
      counts: kit.counts,
      notes: [...imp.notes, ...kit.notes].slice(0, MAX_NOTES),
      lastError: null,
      batches: imp.batches + 1,
      finishedAt: done ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(qboImports.id, imp.id));
  if (done) await audit(ctx, "qbo.import.finished", { counts: kit.counts, notes: imp.notes.length + kit.notes.length });
  return (await getImportView(ctx))!;
}

/** A batch failed (its own work rolled back): say so, so the page can offer to try again. */
export async function recordImportFailure(organizationId: string, message: string): Promise<void> {
  await db
    .update(qboImports)
    .set({ status: "failed", lastError: message.slice(0, 2000), updatedAt: sql`now()` })
    .where(and(eq(qboImports.organizationId, organizationId), sql`${qboImports.status} <> 'done'`));
  // It failed with an error, not a kill: nothing to blame on a record.
  await clearWatch(organizationId);
}

export type ImportView = {
  status: "running" | "failed" | "done" | "none";
  steps: Array<{ key: string; label: string; state: "done" | "current" | "waiting"; imported: number; skipped: number }>;
  notes: string[];
  /** Notes past MAX_NOTES that were dropped (the page says so). */
  notesDropped: boolean;
  /** Every record that didn't come across, by QuickBooks entity and id: complete even when notes were dropped. */
  skipped: Array<{ entity: string; qboIds: string[] }>;
  lastError: string | null;
  /** The last batch was stopped (by the platform) before it could save, and nothing has run since. */
  interrupted: { label: string | null; at: Date } | null;
  batches: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  connection: { companyName: string | null; realmId: string; environment: string; connected: boolean; connectedAt: Date } | null;
};

const notImported = (): ImportView => ({
  status: "none",
  steps: [],
  notes: [],
  notesDropped: false,
  skipped: [],
  lastError: null,
  interrupted: null,
  batches: 0,
  startedAt: null,
  finishedAt: null,
  connection: null,
});

export async function getImportView(ctx: Ctx): Promise<ImportView | null> {
  requirePermission(ctx.actor, "read", "viewer", "view the QuickBooks import");
  const imp = await latestImport(ctx, false);
  const [conn] = await ctx.tx.select().from(qboConnections).where(eq(qboConnections.organizationId, ctx.actor.organizationId));
  if (!imp && !conn) return null;
  const at = imp ? (imp.status === "done" ? STEPS.length : Math.max(0, STEPS.findIndex((s) => s.key === imp.cursor.step))) : 0;
  return {
    status: imp?.status ?? "none",
    steps: STEPS.map((s, i) => ({
      key: s.key,
      label: s.label,
      state: i < at ? "done" : i === at ? "current" : "waiting",
      imported: imp?.counts[s.key]?.imported ?? 0,
      skipped: imp?.counts[s.key]?.skipped ?? 0,
    })),
    notes: imp?.notes ?? [],
    notesDropped: (imp?.notes.length ?? 0) >= MAX_NOTES,
    skipped: imp ? await skippedRecords(ctx) : [],
    lastError: imp?.lastError ?? null,
    interrupted: imp && imp.status !== "done" ? await readInterrupted(ctx, BATCH_LIMIT_SECONDS + 60) : null,
    batches: imp?.batches ?? 0,
    startedAt: imp?.startedAt ?? null,
    finishedAt: imp?.finishedAt ?? null,
    connection: conn
      ? {
          companyName: conn.companyName,
          realmId: conn.realmId,
          environment: conn.environment,
          connected: Boolean(conn.refreshToken),
          connectedAt: conn.connectedAt,
        }
      : null,
  };
}

/** Records remembered as skipped (importTxn and the watch), grouped by QuickBooks entity. */
async function skippedRecords(ctx: Ctx): Promise<ImportView["skipped"]> {
  const rows = await ctx.tx
    .select({ entity: qboIdMap.entity, qboId: qboIdMap.qboId })
    .from(qboIdMap)
    .where(and(eq(qboIdMap.organizationId, ctx.actor.organizationId), eq(qboIdMap.value, "skipped")))
    .orderBy(qboIdMap.entity, qboIdMap.qboId);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.entity, [...(out.get(r.entity) ?? []), r.qboId]);
  return [...out].map(([entity, qboIds]) => ({ entity, qboIds }));
}

/** The import's progress for the API: "none" when the company wasn't imported. */
export async function getImportStatus(ctx: Ctx): Promise<ImportView> {
  return (await getImportView(ctx)) ?? notImported();
}

/** Forget the QuickBooks tokens (and tell Intuit to). The imported books stay. */
export async function disconnectQuickBooks(ctx: Ctx): Promise<void> {
  requireHuman(ctx, "disconnect QuickBooks");
  const conn = await loadConnection(ctx);
  if (conn.refreshToken) await revokeToken(unseal(conn.refreshToken));
  await ctx.tx
    .update(qboConnections)
    .set({ accessToken: null, refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null, disconnectedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(qboConnections.id, conn.id));
  await audit(ctx, "qbo.disconnected", { realmId: conn.realmId });
}
