import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { getAccountRegister, listBankAccountsOverview, type RegisterRow } from "@/lib/banking/reconcile";
import { formatMoney, money } from "@/lib/money";
import { AccountPicker } from "../account-picker";
import { ClearMark, NewTransactionLinks } from "../ui";

const PAGE = 100;

function sourceHref(s: RegisterRow["source"]): string {
  switch (s.type) {
    case "bank_transaction":
      return `/banking/transactions/${s.id}`;
    case "customer_payment":
      return `/ar/payments/${s.id}`;
    case "bill_payment":
      return `/ap/payments/${s.id}`;
    case "sales_receipt":
      return `/ar/sales-receipts/${s.id}`;
    case "refund_receipt":
      return `/ar/refunds/${s.id}`;
    case "sales_tax_payment":
      return `/sales-tax`;
    case "vendor_refund":
      return `/ap/vendor-refunds/${s.id}`;
    default:
      return `/gl/${s.id}`;
  }
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string; offset?: string }>;
}) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const accounts = await runAs(actor, (ctx) => listBankAccountsOverview(ctx));
  const account = accounts.find((a) => a.id === sp.account) ?? accounts[0];
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);

  if (!account) {
    return (
      <AppShell title="Register" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
        <p className="text-sm text-muted-foreground">No bank or card accounts yet.</p>
      </AppShell>
    );
  }

  const page = await runAs(actor, (ctx) =>
    getAccountRegister(ctx, { accountId: account.id, from: sp.from || undefined, to: sp.to || undefined, limit: PAGE, offset })
  );
  const fmt = (v: string) => formatMoney(v, { currency: organization.baseCurrency });
  const card = account.normalBalance === "credit";
  const qs = (o: number) => `/banking/register?account=${account.id}${sp.from ? `&from=${sp.from}` : ""}${sp.to ? `&to=${sp.to}` : ""}&offset=${o}`;

  return (
    <AppShell title="Register" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <AccountPicker accounts={accounts} value={account.id} />
            <div className="text-xs text-muted-foreground">
              {card ? "Owed" : "Balance"} {fmt(account.bookBalance)} · Cleared {fmt(account.clearedBalance)}
            </div>
          </div>
          <NewTransactionLinks accountId={account.id} />
        </div>

        <form className="flex flex-wrap items-end gap-2 text-xs" action="/banking/register">
          <input type="hidden" name="account" value={account.id} />
          <label className="flex flex-col gap-1">
            <span className="uppercase tracking-wider text-muted-foreground text-[10px]">From</span>
            <input type="date" name="from" defaultValue={sp.from} className="rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="uppercase tracking-wider text-muted-foreground text-[10px]">To</span>
            <input type="date" name="to" defaultValue={sp.to} className="rounded-md border border-border bg-background px-2 py-1" />
          </label>
          <button className="rounded-md border border-border px-3 py-1.5 hover:bg-muted">Filter</button>
        </form>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2 w-28">Ref</th>
                <th className="text-left font-medium px-3 py-2">Payee / memo</th>
                <th className="text-right font-medium px-3 py-2 w-28">Payment</th>
                <th className="text-right font-medium px-3 py-2 w-28">{card ? "Charge" : "Deposit"}</th>
                <th className="text-center font-medium px-3 py-2 w-10" title="Cleared / reconciled">✓</th>
                <th className="text-right font-medium px-3 py-2 w-32">Balance</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">Nothing recorded in this account yet.</td>
                </tr>
              )}
              {page.data.map((r) => {
                const amt = money(r.amount);
                // Natural sign: a bank's deposits and a card's charges are positive.
                const increase = amt.gt(0);
                return (
                  <tr key={r.glLineId} className="border-t border-border">
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.date}</td>
                    <td className="px-3 py-2 text-xs font-mono">
                      <Link href={sourceHref(r.source)} className="text-primary hover:underline">
                        {r.reference ?? r.journalNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <div>{r.payee ?? r.description}</div>
                      {r.payee && <div className="text-[11px] text-muted-foreground">{r.description}</div>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{!increase ? fmt(amt.abs().toFixed(4)) : ""}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{increase ? fmt(r.amount) : ""}</td>
                    <td className="px-3 py-2 text-center"><ClearMark state={r.clearing} /></td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmt(r.balance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between text-xs">
          {offset > 0 ? <Link href={qs(Math.max(0, offset - PAGE))} className="text-primary hover:underline">← Newer</Link> : <span />}
          {page.hasMore && <Link href={qs(offset + PAGE)} className="text-primary hover:underline">Older →</Link>}
        </div>
      </div>
    </AppShell>
  );
}
