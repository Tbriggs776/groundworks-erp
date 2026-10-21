"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Landmark, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BankFeedView } from "@/lib/banking/feeds/service";
import { accountOption, Picker } from "../picker";
import { disconnectFeed, finishConnect, finishReconnect, getLinkToken, linkBankAccount, syncFeedNow } from "./actions";

/**
 * Bank feeds: connect a bank through Plaid's sign-in window, link each of
 * its accounts to one in the books, and watch it fill For review.
 */

type PlaidMetadata = { institution?: { name?: string; institution_id?: string } | null };
type PlaidHandler = { open: () => void; destroy: () => void };
type PlaidLink = {
  create: (opts: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: PlaidMetadata) => void;
    onExit: (err: { display_message?: string | null; error_message?: string } | null) => void;
  }) => PlaidHandler;
};
declare global {
  interface Window {
    Plaid?: PlaidLink;
  }
}

/** Banks that sign in with OAuth send the person back here; the token and purpose wait in the tab meanwhile. */
const PENDING_KEY = "gw.plaid.pending";
type Pending = { linkToken: string; scriptUrl: string; connectionId?: string };

function loadScript(src: string): Promise<PlaidLink> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid's sign-in window didn't load.")));
    s.onerror = () => reject(new Error("Plaid's sign-in window didn't load. Check your connection and try again."));
    document.head.appendChild(s);
  });
}

const STATUS: Record<BankFeedView["status"], { label: string; cls: string }> = {
  active: { label: "Connected", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  login_required: { label: "Sign in again", cls: "bg-[var(--gw-gold)]/15 text-[var(--gw-gold-deep)]" },
  disconnected: { label: "Disconnected", cls: "bg-muted text-muted-foreground" },
};

const when = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not yet";
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function FeedsPanel({
  initial,
  accounts,
  configured,
  canManage,
  canSync,
}: {
  initial: BankFeedView[];
  accounts: Array<{ id: string; code: string; name: string }>;
  configured: boolean;
  canManage: boolean;
  canSync: boolean;
}) {
  const router = useRouter();
  const [feeds, setFeeds] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const resumed = useRef(false);

  type Result = { ok: true; feeds: BankFeedView[]; notice?: string } | { ok: false; error: string };
  const apply = (r: Result) => {
    if (r.ok) {
      setFeeds(r.feeds);
      setNotice(r.notice ?? null);
      setErr(null);
    } else setErr(r.error);
  };
  const run = (key: string, fn: () => Promise<Result>) =>
    start(async () => {
      setBusy(key);
      setErr(null);
      setNotice(null);
      try {
        apply(await fn());
      } finally {
        setBusy(null);
      }
    });

  /** Open Plaid's window; when the person finishes, connect the bank (or mark it reconnected). */
  const openLink = async (p: Pending, receivedRedirectUri?: string) => {
    const Plaid = await loadScript(p.scriptUrl);
    const handler = Plaid.create({
      token: p.linkToken,
      receivedRedirectUri,
      onSuccess: (publicToken, metadata) => {
        sessionStorage.removeItem(PENDING_KEY);
        handler.destroy();
        run("link", () =>
          p.connectionId
            ? finishReconnect(p.connectionId)
            : finishConnect({
                publicToken,
                institutionName: metadata.institution?.name ?? undefined,
                institutionId: metadata.institution?.institution_id ?? undefined,
              })
        );
      },
      onExit: (e) => {
        sessionStorage.removeItem(PENDING_KEY);
        handler.destroy();
        if (e) setErr(e.display_message || e.error_message || "The bank sign-in didn't finish.");
      },
    });
    handler.open();
  };

  const startLink = (connectionId?: string) =>
    start(async () => {
      setBusy(connectionId ?? "connect");
      setErr(null);
      setNotice(null);
      try {
        const r = await getLinkToken(connectionId);
        if (!r.ok) return setErr(r.error);
        const p: Pending = { linkToken: r.linkToken, scriptUrl: r.scriptUrl, connectionId };
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
        await openLink(p);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    });

  // Back from a bank's own sign-in page (OAuth): finish in Plaid's window.
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("oauth_state_id")) return;
    let p: Pending | null = null;
    try {
      p = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
    } catch {
      p = null;
    }
    router.replace("/banking/feeds");
    if (!p) return;
    const pending = p;
    const timer = setTimeout(() => openLink(pending, url.toString()).catch((e) => setErr(e instanceof Error ? e.message : String(e))), 0);
    return () => clearTimeout(timer);
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = [{ value: "none", label: "Don't import" }, ...accounts.map(accountOption)];
  const live = feeds.filter((f) => f.status !== "disconnected");
  const gone = feeds.filter((f) => f.status === "disconnected");

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Connect a bank and its posted transactions come into{" "}
          <Link href="/banking/review" className="text-primary hover:underline">
            For review
          </Link>{" "}
          every day, where rules and matching work as they do for an imported statement. Each account starts the day after its last reconciliation or
          imported statement, so nothing already in the books comes in again.
        </p>
        {configured && canManage && (
          <Button onClick={() => startLink()} disabled={pending}>
            {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
            Connect a bank
          </Button>
        )}
      </div>

      {!configured && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Bank feeds aren&apos;t set up for this app yet. Until they are, import statements from{" "}
          <Link href="/banking/review" className="text-primary hover:underline">
            For review
          </Link>
          .
        </div>
      )}
      {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">{err}</div>}
      {notice && <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{notice}</div>}

      {live.length === 0 && configured && (
        <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
          No banks connected yet.{canManage ? " Connect one to start the feed." : " An admin can connect one."}
        </div>
      )}

      {live.map((f) => {
        const s = STATUS[f.status];
        return (
          <div key={f.id} className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{f.institutionName ?? "Bank"}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
                </div>
                <div className="text-xs text-muted-foreground">Last updated {when(f.lastSyncedAt)}</div>
              </div>
              <div className="flex gap-2">
                {canSync && f.status === "active" && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => run(`sync:${f.id}`, () => syncFeedNow(f.id))}>
                    {busy === `sync:${f.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Update now
                  </Button>
                )}
                {canManage && (f.status === "login_required" || f.lastError) && (
                  <Button size="sm" disabled={pending} onClick={() => startLink(f.id)}>
                    {busy === f.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Reconnect
                  </Button>
                )}
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Disconnect ${f.institutionName ?? "this bank"}? Its transactions stop coming in. Lines already in For review stay.`)) {
                        run(`off:${f.id}`, () => disconnectFeed(f.id));
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
            {f.lastError && <div className="border-t border-border bg-[var(--gw-gold)]/10 px-4 py-2 text-sm">{f.lastError}</div>}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-1.5">At the bank</th>
                  <th className="text-left font-medium px-4 py-1.5 w-80">Goes to</th>
                  <th className="text-left font-medium px-4 py-1.5 w-32">Starting</th>
                </tr>
              </thead>
              <tbody>
                {f.accounts.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      <div>
                        {a.name}
                        {a.mask && <span className="text-muted-foreground"> ••{a.mask}</span>}
                      </div>
                      {a.subtype && <div className="text-xs text-muted-foreground capitalize">{a.subtype}</div>}
                    </td>
                    <td className="px-4 py-2">
                      {canManage ? (
                        <Picker
                          size="sm"
                          ariaLabel={`Account for ${a.name}`}
                          options={options}
                          value={a.accountId ?? "none"}
                          onChange={(v) => {
                            const next = v && v !== "none" ? v : null;
                            if (next !== a.accountId) run(`acct:${a.id}`, () => linkBankAccount(a.id, next));
                          }}
                        />
                      ) : a.accountId ? (
                        `${a.accountCode} · ${a.accountName}`
                      ) : (
                        <span className="text-muted-foreground">Not imported</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {busy === `acct:${a.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : a.accountId && a.startDate ? day(a.startDate) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {gone.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Disconnected</div>
          {gone.map((f) => (
            <div key={f.id} className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground">
              {f.institutionName ?? "Bank"} · last updated {when(f.lastSyncedAt)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
