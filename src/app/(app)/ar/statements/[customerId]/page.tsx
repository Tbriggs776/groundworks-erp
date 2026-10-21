import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { customerStatement, type StatementLine } from "@/lib/ar/statements";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { EmailButton } from "@/app/(app)/_email/email-button";
import { EmailHistory } from "@/app/(app)/_email/email-history";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";

const HREF: Record<StatementLine["docKind"], string> = {
  invoice: "/ar/invoices",
  payment: "/ar/payments",
  credit_memo: "/ar/credit-memos",
  refund: "/ar/refunds",
};

export default async function CustomerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { customerId } = await params;
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const s = await runAs(actor, (ctx) => customerStatement(ctx, { id: customerId, from: sp.from || undefined, to: sp.to || undefined })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const fmt = (v: string) => formatMoney(v, { currency: s.customer.currency });
  const q = `from=${s.from}&to=${s.to}`;
  const aging = [
    ["Current", s.aging.current],
    ["1 to 30 days", s.aging.days1to30],
    ["31 to 60 days", s.aging.days31to60],
    ["61 to 90 days", s.aging.days61to90],
    ["Over 90 days", s.aging.over90],
  ] as const;

  return (
    <AppShell title={`Statement · ${s.customer.name}`} crumb={`${organization.name} · Sales · Statements`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{s.customer.name}</div>
            <div className="text-xs text-muted-foreground mt-2">
              Activity {s.from} to {s.to}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {hasRole(actor.role, "bookkeeper") && !actor.support && (
              <EmailButton documentType="statement" documentId={s.customer.id} statement={{ from: s.from, to: s.to }} />
            )}
            <a
              href={`/pdf/statement/${s.customer.id}?${q}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              PDF
            </a>
            <Link href={`/ar/statements?${q}`} className="text-xs text-muted-foreground hover:text-foreground">← All statements</Link>
          </div>
        </div>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Activity</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-right font-medium px-3 py-2 w-32">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{s.from}</td>
                <td className="px-3 py-2 font-semibold">Balance forward</td>
                <td></td>
                <td className="px-3 py-2 text-right font-mono text-xs">{fmt(s.openingBalance)}</td>
              </tr>
              {s.lines.map((l, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{l.date}</td>
                  <td className="px-3 py-2">
                    <Link href={`${HREF[l.docKind]}/${l.docId}`} className="hover:underline">{l.description}</Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30">
              <tr className="border-t-2 border-border">
                <td colSpan={3} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                  {money(s.closingBalance).lt(0) ? "Credit balance" : "Amount due"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{fmt(money(s.closingBalance).abs().toString())}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {s.agingTiesOut ? (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {aging.map(([label, v]) => (
              <div key={label} className="rounded-md border border-border px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="text-sm font-mono mt-0.5">{fmt(v)}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Aging is left off this statement: something voided after {s.to} changed the open balances, so the buckets wouldn&apos;t add up
            to the amount due. A statement dated today always shows it.
          </p>
        )}
        <EmailHistory actor={actor} documentType="statement" documentId={s.customer.id} />
      </div>
    </AppShell>
  );
}
