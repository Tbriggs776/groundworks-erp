import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listBankTransactions } from "@/lib/banking/transactions";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { NewTransactionLinks, TXN_TYPE_LABEL } from "../ui";

const TYPES = ["expense", "check", "deposit", "transfer"] as const;
const PAGE = 100;

export default async function BankTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; offset?: string }>;
}) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const type = TYPES.find((t) => t === sp.type);
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);
  const page = await runAs(actor, (ctx) => listBankTransactions(ctx, { type, q: sp.q || undefined, limit: PAGE, offset }));
  const link = (o: { type?: string; offset?: number }) => {
    const p = new URLSearchParams();
    if (o.type) p.set("type", o.type);
    if (sp.q) p.set("q", sp.q);
    if (o.offset) p.set("offset", String(o.offset));
    return `/banking/transactions${p.size ? `?${p}` : ""}`;
  };

  return (
    <AppShell title="Bank Transactions" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form action="/banking/transactions" className="flex gap-2">
            {type && <input type="hidden" name="type" value={type} />}
            <input
              name="q"
              defaultValue={sp.q}
              placeholder="Search payee, number, memo…"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs w-64"
            />
          </form>
          <NewTransactionLinks />
        </div>
        <div className="flex gap-1 border-b border-border">
          {[undefined, ...TYPES].map((t) => (
            <Link
              key={t ?? "all"}
              href={link({ type: t })}
              className={cn(
                "px-3 py-2 text-xs font-medium border-b-2 -mb-px",
                t === type ? "border-[var(--gw-gold)] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t ? `${TXN_TYPE_LABEL[t]}s` : "All"}
            </Link>
          ))}
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2 w-24">Type</th>
                <th className="text-left font-medium px-3 py-2">Payee</th>
                <th className="text-left font-medium px-3 py-2">Account</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">No bank transactions yet.</td>
                </tr>
              )}
              {page.data.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/banking/transactions/${t.id}`} className="text-primary hover:underline">{t.txnNumber}</Link>
                    {t.reference && <div className="text-[11px] text-muted-foreground">#{t.reference}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{t.txnDate}</td>
                  <td className="px-3 py-2 text-xs">{TXN_TYPE_LABEL[t.type]}</td>
                  <td className="px-3 py-2">{t.payee ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-xs">
                    {t.bankAccountName}
                    {t.transferAccountName && <> → {t.transferAccountName}</>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(t.totalAmount, { currency: t.currency })}</td>
                  <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between text-xs">
          {offset > 0 ? <Link href={link({ type, offset: Math.max(0, offset - PAGE) })} className="text-primary hover:underline">← Newer</Link> : <span />}
          {page.hasMore && <Link href={link({ type, offset: offset + PAGE })} className="text-primary hover:underline">Older →</Link>}
        </div>
      </div>
    </AppShell>
  );
}
