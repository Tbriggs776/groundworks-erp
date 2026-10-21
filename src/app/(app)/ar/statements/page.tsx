import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { listStatements, type Statement } from "@/lib/ar/statements";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { EmailButton } from "@/app/(app)/_email/email-button";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";

/** Balance forward statements for every customer with a balance or activity. */
export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; all?: string }> }) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const canEmail = hasRole(actor.role, "bookkeeper") && !actor.support;
  const includeZero = sp.all === "1";
  // A bad date range shows as a message, not an error page.
  const { list, error } = await runAs(actor, (ctx) => listStatements(ctx, { from: sp.from || undefined, to: sp.to || undefined, includeZero })).then(
    (list) => ({ list, error: null }),
    (e) => ({ list: [] as Statement[], error: toAppError(e).message })
  );
  const from = list[0]?.from ?? sp.from ?? "";
  const to = list[0]?.to ?? sp.to ?? "";
  const q = `from=${from}&to=${to}`;
  const field = "rounded-md border border-border bg-background px-2 py-1.5 text-sm";

  return (
    <AppShell title="Statements" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <form className="flex flex-wrap items-end gap-3" method="get">
          <label className="text-xs text-muted-foreground flex flex-col gap-1">
            Activity from
            <input type="date" name="from" defaultValue={from} className={field} />
          </label>
          <label className="text-xs text-muted-foreground flex flex-col gap-1">
            Statement date
            <input type="date" name="to" defaultValue={to} className={field} />
          </label>
          <label className="text-xs text-muted-foreground flex items-center gap-2 pb-2">
            <input type="checkbox" name="all" value="1" defaultChecked={includeZero} className="h-3.5 w-3.5 accent-[var(--primary)]" />
            Include customers with nothing to show
          </label>
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent">
            Show
          </button>
          {list.length > 0 && (
            <a
              href={`/pdf/statements?${q}${includeZero ? "&includeZero=1" : ""}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              All statements (PDF)
            </a>
          )}
        </form>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-right font-medium px-3 py-2 w-32">Balance forward</th>
                <th className="text-right font-medium px-3 py-2 w-32">Charges</th>
                <th className="text-right font-medium px-3 py-2 w-36">Payments, credits</th>
                <th className="text-right font-medium px-3 py-2 w-32">Balance</th>
                <th className="text-right font-medium px-3 py-2 w-44">Statement</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && !error && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No customer has a balance or activity in this period.
                  </td>
                </tr>
              )}
              {list.map((s) => {
                const fmt = (v: string) => formatMoney(v, { currency: s.customer.currency });
                return (
                  <tr key={s.customer.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link href={`/ar/statements/${s.customer.id}?${q}`} className="text-primary hover:underline">{s.customer.name}</Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmt(s.openingBalance)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(s.charges).isZero() ? "—" : fmt(s.charges)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{money(s.credits).isZero() ? "—" : fmt(s.credits)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold">{fmt(s.closingBalance)}</td>
                    <td className="px-3 py-2 text-right text-xs">
                      <div className="flex items-center justify-end gap-3">
                        {canEmail && <EmailButton documentType="statement" documentId={s.customer.id} statement={{ from: s.from, to: s.to }} />}
                        <a href={`/pdf/statement/${s.customer.id}?${q}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          PDF
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Balance forward statements: the balance at the start, each invoice, payment, and credit in the period, and the balance on the
          statement date, with aging. Email sends the PDF to the customer&apos;s saved address.
        </p>
      </div>
    </AppShell>
  );
}
