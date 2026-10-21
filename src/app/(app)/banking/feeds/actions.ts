"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import {
  connectBank,
  createLinkToken,
  disconnectBank,
  linkFeedAccount,
  listBankFeeds,
  markReconnected,
  syncBankFeed,
  type BankFeedView,
  type SyncResult,
} from "@/lib/banking/feeds/service";

/** Bank feed actions: wrappers over src/lib/banking/feeds/service.ts. */

type Feeds = { feeds: BankFeedView[]; notice?: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describe(r: SyncResult): string {
  if (r.error) return r.error;
  const parts = [
    r.added > 0 && `${plural(r.added, "new transaction")} in For review`,
    r.rules.categorized > 0 && `${r.rules.categorized} categorized by rules`,
    r.rules.autoAdded > 0 && `${r.rules.autoAdded} added by rules`,
    r.updated > 0 && `${plural(r.updated, "line")} updated by the bank`,
    r.removed > 0 && `${plural(r.removed, "line")} the bank withdrew taken out`,
    r.changedAfterReview > 0 && `${plural(r.changedAfterReview, "change")} by the bank to lines already reviewed (left as they are; check them)`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "Up to date: nothing new from the bank.";
}

/** Sync in its own transaction, so a bank that fails never undoes what came before. */
async function syncThen(connectionId: string, before?: string): Promise<ActionResult<Feeds>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const sync = await syncBankFeed(ctx, { id: connectionId });
    return { feeds: await listBankFeeds(ctx), notice: [before, describe(sync)].filter(Boolean).join(" ") };
  });
  revalidatePath("/banking", "layout");
  return r;
}

export async function getLinkToken(connectionId?: string): Promise<ActionResult<{ linkToken: string; scriptUrl: string }>> {
  return serviceAction("admin", (ctx) => createLinkToken(ctx, { connectionId }));
}

export async function finishConnect(input: { publicToken: string; institutionName?: string; institutionId?: string }): Promise<ActionResult<Feeds>> {
  const r = await serviceAction("admin", async (ctx) => ({
    feeds: await connectBank(ctx, input),
    notice: "Connected. Choose the account in your books each bank account feeds, and its transactions come into For review.",
  }));
  if (r.ok) revalidatePath("/banking/feeds");
  return r;
}

export async function linkBankAccount(feedAccountId: string, accountId: string | null): Promise<ActionResult<Feeds>> {
  const r = await serviceAction("admin", async (ctx) => ({ feeds: await linkFeedAccount(ctx, { id: feedAccountId, accountId }) }));
  if (!r.ok) return r;
  const conn = r.feeds.find((f) => f.accounts.some((a) => a.id === feedAccountId));
  if (!accountId || !conn || conn.status !== "active") {
    revalidatePath("/banking/feeds");
    return r;
  }
  const synced = await syncThen(conn.id, "Linked.");
  return synced.ok ? synced : { ok: true, feeds: r.feeds, notice: `Linked. Updating from the bank failed: ${synced.error}` };
}

export async function syncFeedNow(connectionId: string): Promise<ActionResult<Feeds>> {
  return syncThen(connectionId);
}

export async function finishReconnect(connectionId: string): Promise<ActionResult<Feeds>> {
  const r = await serviceAction("admin", async (ctx) => ({ feeds: await markReconnected(ctx, { id: connectionId }) }));
  if (!r.ok) return r;
  const synced = await syncThen(connectionId, "Reconnected.");
  return synced.ok ? synced : { ok: true, feeds: r.feeds, notice: `Reconnected. Updating from the bank failed: ${synced.error}` };
}

export async function disconnectFeed(connectionId: string): Promise<ActionResult<Feeds>> {
  const r = await serviceAction("admin", async (ctx) => ({
    feeds: await disconnectBank(ctx, { id: connectionId }),
    notice: "Disconnected. Lines already in For review stay there.",
  }));
  if (r.ok) revalidatePath("/banking/feeds");
  return r;
}
