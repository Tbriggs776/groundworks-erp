import { addDays, format, parseISO, subDays } from "date-fns";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankFeedAccounts,
  bankFeedConnections,
  bankStatementImports,
  bankStatementLines,
  reconciliations,
  type BankFeedConnection,
} from "@/lib/db/schema";
import { auditFields, requirePermission, runAs, systemActor, type Ctx } from "@/lib/actor";
import { db } from "@/lib/db/client";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import { id } from "@/lib/schemas";
import { seal, unseal } from "@/lib/security/crypto";
import { requireBankingAccount } from "../common";
import type { ParsedLine } from "../parse";
import { ingestLines, type RuleRunResult } from "../review";
import { linkScriptUrl, plaid, plaidConfig, plaidConfigured, type PlaidAccount, type PlaidTransaction, type SyncPage } from "./plaid";

/**
 * BANK FEEDS. A person connects a bank through Plaid's sign-in window,
 * then links each of the bank's accounts to a bank or card account in the
 * chart. Syncing pulls the bank's posted transactions (never pending ones)
 * into For review as statement lines, where rules, matching, and review
 * treat them like an imported statement. Each linked account starts the
 * day after its last reconciliation or imported statement (90 days back
 * when there's neither), so nothing already in the books comes in again.
 *
 * People (admins and owners) connect, link, reconnect, and disconnect.
 * Syncing is routine: agents, the daily job, and Plaid's webhooks run it.
 */

const IdSchema = z.object({ id });
const NEW_ACCOUNT_DAYS = 90;
const MAX_PAGES = 100;

function requirePerson(ctx: Ctx, action: string) {
  requirePermission(ctx.actor, "admin", "admin", action);
  if (ctx.actor.kind !== "user") throw new AppError("forbidden", `Only people can ${action}.`);
}

async function loadConnection(ctx: Ctx, connectionId: string): Promise<BankFeedConnection> {
  const [c] = await ctx.tx
    .select()
    .from(bankFeedConnections)
    .where(and(eq(bankFeedConnections.id, connectionId), eq(bankFeedConnections.organizationId, ctx.actor.organizationId)));
  if (!c) throw notFound("Bank connection");
  return c;
}

const audit = (ctx: Ctx, event: string, entityId: string, metadata: Record<string, unknown>) =>
  writeAudit({ organizationId: ctx.actor.organizationId, ...auditFields(ctx.actor), event, entityType: "bank_feed_connection", entityId, metadata }, ctx.tx);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type BankFeedView = {
  id: string;
  institutionName: string | null;
  status: BankFeedConnection["status"];
  lastSyncedAt: Date | null;
  lastError: string | null;
  connectedAt: Date;
  accounts: Array<{
    id: string;
    name: string;
    mask: string | null;
    type: string | null;
    subtype: string | null;
    accountId: string | null;
    accountCode: string | null;
    accountName: string | null;
    startDate: string | null;
  }>;
};

export async function listBankFeeds(ctx: Ctx): Promise<BankFeedView[]> {
  requirePermission(ctx.actor, "read", "viewer", "view bank feeds");
  const org = ctx.actor.organizationId;
  const conns = await ctx.tx
    .select()
    .from(bankFeedConnections)
    .where(eq(bankFeedConnections.organizationId, org))
    .orderBy(asc(bankFeedConnections.connectedAt));
  const accts = await ctx.tx
    .select({ a: bankFeedAccounts, code: accounts.code, accountName: accounts.name })
    .from(bankFeedAccounts)
    .leftJoin(accounts, eq(accounts.id, bankFeedAccounts.accountId))
    .where(eq(bankFeedAccounts.organizationId, org))
    .orderBy(asc(bankFeedAccounts.name));
  return conns.map((c) => ({
    id: c.id,
    institutionName: c.institutionName,
    status: c.status,
    lastSyncedAt: c.lastSyncedAt,
    lastError: c.lastError,
    connectedAt: c.connectedAt,
    accounts: accts
      .filter((r) => r.a.connectionId === c.id)
      .map((r) => ({
        id: r.a.id,
        name: r.a.name,
        mask: r.a.mask,
        type: r.a.type,
        subtype: r.a.subtype,
        accountId: r.a.accountId,
        accountCode: r.code,
        accountName: r.accountName,
        startDate: r.a.startDate,
      })),
  }));
}

// ---------------------------------------------------------------------------
// Connect, reconnect, disconnect
// ---------------------------------------------------------------------------

export const LinkTokenSchema = z.object({ connectionId: id.optional().describe("Reconnect this bank (its sign-in expired) instead of adding one.") });

/** A short-lived token that opens Plaid's sign-in window (to add a bank, or sign in again to one). */
export async function createLinkToken(ctx: Ctx, input: z.input<typeof LinkTokenSchema> = {}): Promise<{ linkToken: string; scriptUrl: string }> {
  requirePerson(ctx, "connect banks");
  const d = LinkTokenSchema.parse(input);
  const cfg = plaidConfig();
  const conn = d.connectionId ? await loadConnection(ctx, d.connectionId) : null;
  if (conn && !conn.accessToken) throw new AppError("invalid_state", "That bank was disconnected. Connect it again as a new bank.");
  const r = await plaid<{ link_token: string }>("/link/token/create", {
    client_name: "Groundworks",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: ctx.actor.userId },
    webhook: cfg.webhookUrl,
    ...(cfg.redirectUri ? { redirect_uri: cfg.redirectUri } : {}),
    ...(conn ? { access_token: unseal(conn.accessToken!) } : { products: ["transactions"], transactions: { days_requested: 730 } }),
  });
  return { linkToken: r.link_token, scriptUrl: linkScriptUrl() };
}

export const ConnectBankSchema = z.object({
  publicToken: z.string().min(1).max(500).describe("What Plaid's sign-in window hands back."),
  institutionName: z.string().trim().max(200).optional(),
  institutionId: z.string().trim().max(100).optional(),
});

/** After Plaid's sign-in: keep the bank's access (sealed) and its accounts, ready to link. */
export async function connectBank(ctx: Ctx, input: z.input<typeof ConnectBankSchema>): Promise<BankFeedView[]> {
  requirePerson(ctx, "connect banks");
  const d = ConnectBankSchema.parse(input);
  const org = ctx.actor.organizationId;
  const ex = await plaid<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: d.publicToken });
  const { accounts: bankAccounts } = await plaid<{ accounts: PlaidAccount[] }>("/accounts/get", { access_token: ex.access_token });
  const [taken] = await ctx.tx.select().from(bankFeedConnections).where(eq(bankFeedConnections.itemId, ex.item_id));
  if (taken && taken.organizationId !== org) throw new AppError("conflict", "That bank login is already connected to another company.");
  const values = {
    institutionName: d.institutionName ?? null,
    institutionId: d.institutionId ?? null,
    accessToken: seal(ex.access_token),
    cursor: null,
    status: "active" as const,
    lastError: null,
    connectedBy: ctx.actor.userId,
    disconnectedAt: null,
  };
  const [conn] = taken
    ? await ctx.tx.update(bankFeedConnections).set({ ...values, connectedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(bankFeedConnections.id, taken.id)).returning()
    : await ctx.tx.insert(bankFeedConnections).values({ organizationId: org, itemId: ex.item_id, ...values }).returning();
  for (const a of bankAccounts) {
    await ctx.tx
      .insert(bankFeedAccounts)
      .values({
        organizationId: org,
        connectionId: conn.id,
        externalId: a.account_id,
        name: (a.name || "Account").slice(0, 200),
        officialName: a.official_name?.slice(0, 200) ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
        subtype: a.subtype ?? null,
      })
      .onConflictDoNothing({ target: [bankFeedAccounts.connectionId, bankFeedAccounts.externalId] });
  }
  await audit(ctx, "bank.feed.connected", conn.id, { institution: d.institutionName ?? null, accounts: bankAccounts.length });
  return listBankFeeds(ctx);
}

/** After signing in again through Plaid's window: the connection works again. */
export async function markReconnected(ctx: Ctx, input: { id: string }): Promise<BankFeedView[]> {
  requirePerson(ctx, "reconnect banks");
  const { id: connectionId } = IdSchema.parse(input);
  const conn = await loadConnection(ctx, connectionId);
  if (!conn.accessToken) throw new AppError("invalid_state", "That bank was disconnected. Connect it again as a new bank.");
  await ctx.tx
    .update(bankFeedConnections)
    .set({ status: "active", lastError: null, updatedAt: sql`now()` })
    .where(eq(bankFeedConnections.id, conn.id));
  await audit(ctx, "bank.feed.reconnected", conn.id, { institution: conn.institutionName });
  return listBankFeeds(ctx);
}

/** Stop the feed and tell Plaid to forget the login. Lines already in For review stay. */
export async function disconnectBank(ctx: Ctx, input: { id: string }): Promise<BankFeedView[]> {
  requirePerson(ctx, "disconnect banks");
  const { id: connectionId } = IdSchema.parse(input);
  const conn = await loadConnection(ctx, connectionId);
  if (conn.accessToken) {
    await plaid("/item/remove", { access_token: unseal(conn.accessToken) }).catch(() => undefined);
  }
  await ctx.tx
    .update(bankFeedConnections)
    .set({ accessToken: null, cursor: null, status: "disconnected", disconnectedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(bankFeedConnections.id, conn.id));
  await audit(ctx, "bank.feed.disconnected", conn.id, { institution: conn.institutionName });
  return listBankFeeds(ctx);
}

// ---------------------------------------------------------------------------
// Linking a bank account to the chart
// ---------------------------------------------------------------------------

export const LinkFeedAccountSchema = z.object({
  id: id.describe("The bank's account (from list_bank_feeds)."),
  accountId: id.nullable().describe("Bank or card account in the chart its transactions go to; null to stop importing it."),
});

/** The day after the last reconciliation or imported statement line, or 90 days back. */
async function startDateFor(ctx: Ctx, accountId: string): Promise<string> {
  const [rec] = await ctx.tx
    .select({ end: reconciliations.statementEndDate })
    .from(reconciliations)
    .where(and(eq(reconciliations.accountId, accountId), eq(reconciliations.status, "completed")))
    .orderBy(desc(reconciliations.statementEndDate))
    .limit(1);
  const [line] = await ctx.tx
    .select({ last: sql<string | null>`max(${bankStatementLines.postedDate})::text` })
    .from(bankStatementLines)
    .innerJoin(bankStatementImports, eq(bankStatementImports.id, bankStatementLines.importId))
    .where(and(eq(bankStatementLines.accountId, accountId), ne(bankStatementImports.format, "feed")));
  const after = [rec?.end, line?.last].filter((x): x is string => Boolean(x)).sort().pop();
  return after ? format(addDays(parseISO(after), 1), "yyyy-MM-dd") : format(subDays(new Date(), NEW_ACCOUNT_DAYS), "yyyy-MM-dd");
}

export async function linkFeedAccount(ctx: Ctx, input: z.input<typeof LinkFeedAccountSchema>): Promise<BankFeedView[]> {
  requirePerson(ctx, "link bank feeds to accounts");
  const d = LinkFeedAccountSchema.parse(input);
  const org = ctx.actor.organizationId;
  const [fa] = await ctx.tx
    .select()
    .from(bankFeedAccounts)
    .where(and(eq(bankFeedAccounts.id, d.id), eq(bankFeedAccounts.organizationId, org)));
  if (!fa) throw notFound("Bank account");
  let startDate: string | null = null;
  if (d.accountId) {
    const conn = await loadConnection(ctx, fa.connectionId);
    if (conn.status === "disconnected") throw new AppError("invalid_state", "That bank is disconnected. Connect it again first.");
    const account = await requireBankingAccount(ctx.tx, org, d.accountId, { reconcilable: true });
    const [other] = await ctx.tx
      .select({ name: bankFeedAccounts.name })
      .from(bankFeedAccounts)
      .innerJoin(bankFeedConnections, eq(bankFeedConnections.id, bankFeedAccounts.connectionId))
      .where(
        and(
          eq(bankFeedAccounts.organizationId, org),
          eq(bankFeedAccounts.accountId, account.id),
          ne(bankFeedAccounts.id, fa.id),
          ne(bankFeedConnections.status, "disconnected")
        )
      );
    if (other) throw new AppError("conflict", `${account.code} ${account.name} already gets ${other.name}'s feed. Unlink that one first.`);
    startDate = await startDateFor(ctx, account.id);
  }
  await ctx.tx
    .update(bankFeedAccounts)
    .set({ accountId: d.accountId, startDate, updatedAt: sql`now()` })
    .where(eq(bankFeedAccounts.id, fa.id));
  // Read the bank's history again so the newly linked account gets its part (lines already in come back as duplicates).
  await ctx.tx.update(bankFeedConnections).set({ cursor: null, updatedAt: sql`now()` }).where(eq(bankFeedConnections.id, fa.connectionId));
  await audit(ctx, d.accountId ? "bank.feed.account_linked" : "bank.feed.account_unlinked", fa.connectionId, {
    bankAccount: fa.name,
    accountId: d.accountId,
    startDate,
  });
  return listBankFeeds(ctx);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export type SyncResult = {
  status: BankFeedConnection["status"];
  /** New lines in For review. */
  added: number;
  /** Lines the bank changed while they waited in For review. */
  updated: number;
  /** Lines the bank withdrew while they waited in For review (taken out). */
  removed: number;
  /** Changes to lines already reviewed: left as reviewed, to check by hand. */
  changedAfterReview: number;
  rules: RuleRunResult;
  error: string | null;
};

const noRules = (): RuleRunResult => ({ categorized: 0, autoAdded: 0, autoAddHeld: 0, errors: [] });

function toLine(t: PlaidTransaction): ParsedLine {
  return {
    postedDate: t.date,
    // Plaid's positive is money out; here, money out is negative.
    amount: toDbMoney(money(String(t.amount)).neg()),
    description: (t.original_description || t.name || t.merchant_name || "Bank transaction").slice(0, 500),
    payee: t.merchant_name?.slice(0, 200) ?? null,
    reference: t.check_number?.slice(0, 100) ?? null,
    fitId: `plaid:${t.transaction_id}`,
  };
}

/** Pull what's new from the bank into For review. */
export async function syncBankFeed(ctx: Ctx, input: { id: string }): Promise<SyncResult> {
  requirePermission(ctx.actor, "write", "bookkeeper", "update bank feeds");
  const { id: connectionId } = IdSchema.parse(input);
  // Locked, so a webhook, the daily run, and a person's "Update now" take turns on one bank.
  const [conn] = await ctx.tx
    .select()
    .from(bankFeedConnections)
    .where(and(eq(bankFeedConnections.id, connectionId), eq(bankFeedConnections.organizationId, ctx.actor.organizationId)))
    .for("update");
  if (!conn) throw notFound("Bank connection");
  if (conn.status === "disconnected" || !conn.accessToken) throw new AppError("invalid_state", "That bank is disconnected.");
  const result: SyncResult = { status: conn.status, added: 0, updated: 0, removed: 0, changedAfterReview: 0, rules: noRules(), error: null };

  // Read every page of changes from the saved cursor (restarting once if the bank changed mid-read).
  const pages: SyncPage[] = [];
  let cursor = conn.cursor;
  try {
    for (let attempt = 0; ; attempt++) {
      pages.length = 0;
      cursor = conn.cursor;
      try {
        for (let n = 0; n < MAX_PAGES; n++) {
          const page = await plaid<SyncPage>("/transactions/sync", {
            access_token: unseal(conn.accessToken),
            ...(cursor ? { cursor } : {}),
            count: 500,
            options: { include_original_description: true },
          });
          pages.push(page);
          cursor = page.next_cursor;
          if (!page.has_more) break;
        }
        break;
      } catch (e) {
        if (attempt === 0 && e instanceof AppError && e.details?.plaidError === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue;
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof AppError && e.code === "invalid_state" && e.details?.plaidError) {
      await ctx.tx
        .update(bankFeedConnections)
        .set({ status: "login_required", lastError: e.message, updatedAt: sql`now()` })
        .where(eq(bankFeedConnections.id, conn.id));
      return { ...result, status: "login_required", error: e.message };
    }
    throw e;
  }

  const linked = new Map(
    (await ctx.tx.select().from(bankFeedAccounts).where(eq(bankFeedAccounts.connectionId, conn.id))).map((a) => [a.externalId, a])
  );
  const wanted = (t: PlaidTransaction) => {
    const a = linked.get(t.account_id);
    return !t.pending && a?.accountId && (!a.startDate || t.date >= a.startDate) ? a : null;
  };
  // Lines already in for the bank's changes, by transaction (two when its bank account moved to another account in the chart).
  const linesFor = async (page: SyncPage) => {
    const ids = [...page.modified, ...page.removed].map((t) => `plaid:${t.transaction_id}`);
    const rows = ids.length
      ? await ctx.tx
          .select()
          .from(bankStatementLines)
          .where(and(eq(bankStatementLines.organizationId, ctx.actor.organizationId), inArray(bankStatementLines.fitId, ids)))
      : [];
    return (transactionId: string) => rows.filter((r) => r.fitId === `plaid:${transactionId}`);
  };

  const fresh = new Map<string, { feed: string; lines: ParsedLine[] }>();
  const queue = (t: PlaidTransaction) => {
    const a = wanted(t);
    if (!a) return;
    const g = fresh.get(a.accountId!) ?? { feed: `${conn.institutionName ?? "Bank"} · ${a.name}${a.mask ? ` ••${a.mask}` : ""}`, lines: [] };
    g.lines.push(toLine(t));
    fresh.set(a.accountId!, g);
  };
  for (const page of pages) {
    const findLines = await linesFor(page);
    for (const t of page.added) queue(t);
    for (const t of page.modified) {
      const lines = findLines(t.transaction_id);
      if (lines.length === 0) {
        queue(t);
        continue;
      }
      if (t.pending) continue;
      const l = toLine(t);
      for (const line of lines) {
        if (line.status !== "for_review") {
          result.changedAfterReview++;
          continue;
        }
        await ctx.tx
          .update(bankStatementLines)
          .set({ postedDate: l.postedDate, amount: l.amount, description: l.description, payee: l.payee, reference: l.reference, updatedAt: sql`now()` })
          .where(eq(bankStatementLines.id, line.id));
        result.updated++;
      }
    }
    for (const r of page.removed) {
      for (const line of findLines(r.transaction_id)) {
        if (line.status !== "for_review") {
          result.changedAfterReview++;
          continue;
        }
        await ctx.tx.delete(bankStatementLines).where(eq(bankStatementLines.id, line.id));
        result.removed++;
      }
    }
  }
  for (const [accountId, g] of fresh) {
    const r = await ingestLines(ctx, { accountId, format: "feed", fileName: g.feed, lines: g.lines, applyRules: true, audit: { feed: conn.id } });
    result.added += r.newCount;
    result.rules = {
      categorized: result.rules.categorized + r.rules.categorized,
      autoAdded: result.rules.autoAdded + r.rules.autoAdded,
      autoAddHeld: result.rules.autoAddHeld + r.rules.autoAddHeld,
      errors: [...result.rules.errors, ...r.rules.errors],
    };
  }

  await ctx.tx
    .update(bankFeedConnections)
    .set({ cursor, status: "active", lastError: null, lastSyncedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(bankFeedConnections.id, conn.id));
  await audit(ctx, "bank.feed.synced", conn.id, {
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    changedAfterReview: result.changedAfterReview,
  });
  return { ...result, status: "active" };
}

/**
 * The daily job: every working connection of the company, each in its own
 * transaction, so one bank that fails doesn't hold up or undo the rest.
 */
export async function runBankFeedsForOrg(organizationId: string): Promise<{ checked: number; synced: number; failed: number; errors: string[] }> {
  const out = { checked: 0, synced: 0, failed: 0, errors: [] as string[] };
  if (!plaidConfigured()) return out;
  const conns = await db
    .select({ id: bankFeedConnections.id, name: bankFeedConnections.institutionName })
    .from(bankFeedConnections)
    .where(and(eq(bankFeedConnections.organizationId, organizationId), eq(bankFeedConnections.status, "active")));
  const actor = systemActor(organizationId);
  for (const c of conns) {
    out.checked++;
    try {
      const r = await runAs(actor, (ctx) => syncBankFeed(ctx, { id: c.id }));
      if (r.error) throw new Error(r.error);
      out.synced++;
    } catch (e) {
      out.failed++;
      out.errors.push(`${c.name ?? c.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type PlaidWebhook = {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string; error_message?: string; display_message?: string | null } | null;
};

/** The connection a webhook names (Plaid's item id is unique across companies). */
export async function connectionForItem(itemId: string | undefined): Promise<{ id: string; organizationId: string } | null> {
  if (!itemId) return null;
  const [c] = await db
    .select({ id: bankFeedConnections.id, organizationId: bankFeedConnections.organizationId })
    .from(bankFeedConnections)
    .where(eq(bankFeedConnections.itemId, itemId));
  return c ?? null;
}

/** What Plaid tells us about a connection (signature already checked). */
export async function handleFeedWebhook(ctx: Ctx, connectionId: string, body: PlaidWebhook): Promise<void> {
  const conn = await loadConnection(ctx, connectionId);
  if (conn.status === "disconnected") return;
  const code = `${body.webhook_type ?? ""}:${body.webhook_code ?? ""}`;
  const set = (values: Partial<typeof bankFeedConnections.$inferInsert>) =>
    ctx.tx.update(bankFeedConnections).set({ ...values, updatedAt: sql`now()` }).where(eq(bankFeedConnections.id, conn.id));

  if (body.webhook_type === "TRANSACTIONS" && ["SYNC_UPDATES_AVAILABLE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "DEFAULT_UPDATE"].includes(body.webhook_code ?? "")) {
    if (conn.status === "active") await syncBankFeed(ctx, { id: conn.id });
  } else if (body.webhook_type === "ITEM" && body.webhook_code === "ERROR") {
    await set({ status: "login_required", lastError: body.error?.display_message ?? body.error?.error_message ?? "The bank needs you to sign in again." });
  } else if (body.webhook_type === "ITEM" && (body.webhook_code === "PENDING_EXPIRATION" || body.webhook_code === "PENDING_DISCONNECT")) {
    await set({ lastError: "The bank's sign-in expires soon. Reconnect it to keep the feed going." });
  } else if (body.webhook_type === "ITEM" && (body.webhook_code === "USER_PERMISSION_REVOKED" || body.webhook_code === "USER_ACCOUNT_REVOKED")) {
    await set({ status: "login_required", lastError: "Access to this bank was revoked at the bank. Reconnect it to keep the feed going." });
  } else if (body.webhook_type === "ITEM" && body.webhook_code === "LOGIN_REPAIRED") {
    await set({ status: "active", lastError: null });
  }
  await audit(ctx, "bank.feed.webhook", conn.id, { code });
}
