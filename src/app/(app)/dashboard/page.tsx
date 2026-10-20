import Link from "next/link";
import { format, startOfYear } from "date-fns";
import { Bot, FileText, HandCoins, Receipt } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { listAgents } from "@/lib/agents/service";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listAccounts } from "@/lib/gl/accounts";
import { getIncomeStatement } from "@/lib/gl/reports";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { apAging, arAging } from "@/lib/reports/aging";
import { listReviewQueue } from "@/lib/review";

export default async function DashboardPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const today = format(new Date(), "yyyy-MM-dd");
  const currency = organization.baseCurrency;

  const [cashAccounts, ar, ap, review, agents, pnl] = await Promise.all([
    runAs(actor, (ctx) => listAccounts(ctx, { cashOnly: true, withBalances: true })),
    runAs(actor, (ctx) => arAging(ctx, { asOf: today })),
    runAs(actor, (ctx) => apAging(ctx, { asOf: today })),
    runAs(actor, (ctx) => listReviewQueue(ctx)),
    runAs(actor, (ctx) => listAgents(ctx)),
    getIncomeStatement(organization.id, {
      fromDate: format(startOfYear(new Date()), "yyyy-MM-dd"),
      toDate: today,
    }),
  ]);

  const cash = sumMoney(cashAccounts.map((a) => a.balance ?? "0"));
  const arOverdue = money(ar.totals.total).minus(money(ar.totals.current));
  const apOverdue = money(ap.totals.total).minus(money(ap.totals.current));
  const fmt = (v: string | ReturnType<typeof money>) => formatMoney(v, { currency });

  return (
    <AppShell title="Dashboard" crumb={`${organization.name} · Overview`} userEmail={user?.email}>
      <div className="max-w-6xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{organization.name.toUpperCase()}</h1>
            <div className="text-xs text-muted-foreground mt-1">
              {currency} · You are <span className="text-primary">{role}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <QuickLink href="/ar/invoices/new" icon={FileText} label="New invoice" />
            <QuickLink href="/ar/payments/new" icon={HandCoins} label="Receive payment" />
            <QuickLink href="/ap/bills/new" icon={Receipt} label="Enter bill" />
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Cash on hand" value={fmt(cash)} href="/banking" hint={`${cashAccounts.length} bank & cash accounts`} />
          <Stat
            label="Owed to you"
            value={fmt(ar.totals.total)}
            href="/reports/ar-aging"
            hint={arOverdue.gt(0) ? `${fmt(arOverdue)} overdue` : "Nothing overdue"}
            alert={arOverdue.gt(0)}
          />
          <Stat
            label="You owe"
            value={fmt(ap.totals.total)}
            href="/reports/ap-aging"
            hint={apOverdue.gt(0) ? `${fmt(apOverdue)} overdue` : "Nothing overdue"}
            alert={apOverdue.gt(0)}
          />
          <Stat
            label="Net income YTD"
            value={fmt(pnl.netIncome.toFixed(4))}
            href="/reports/income-statement"
            hint={`Revenue ${fmt(pnl.revenue.total.toFixed(4))}`}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Link
            href="/review"
            className="rounded-lg border border-border bg-card p-5 hover:border-ring transition-colors block"
          >
            <div className="text-[10px] tracking-[0.22em] uppercase text-muted-foreground">Review queue</div>
            <div className="text-3xl font-semibold tracking-tight mt-1">{review.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {review.length === 0
                ? "Nothing waiting on you."
                : reviewSummary(review)}
            </p>
          </Link>
          <Link
            href="/settings/agents"
            className="rounded-lg border border-border bg-card p-5 hover:border-ring transition-colors block"
          >
            <div className="flex items-center gap-2 text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
              <Bot className="h-3.5 w-3.5" /> Agents
            </div>
            {agents.length === 0 ? (
              <p className="text-sm mt-2">
                Connect Claude or any MCP client to these books. Create an agent, give it a key, and let it draft
                invoices, enter bills, and answer questions, with you approving what posts.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {agents.slice(0, 4).map((a) => (
                  <li key={a.id} className="flex justify-between gap-2">
                    <span className="truncate">{a.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {a.lastActiveAt ? `active ${new Date(a.lastActiveAt).toLocaleDateString()}` : "never used"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Link>
        </div>

        {ar.parties.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] tracking-[0.22em] uppercase text-muted-foreground">Largest balances owed to you</div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[...ar.parties]
                    .sort((a, b) => money(b.buckets.total).comparedTo(money(a.buckets.total)))
                    .slice(0, 5)
                    .map((p) => (
                      <tr key={p.partyId} className="border-t border-border first:border-t-0">
                        <td className="px-3 py-2">{p.partyName}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {p.documents.length} open invoice{p.documents.length === 1 ? "" : "s"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{fmt(p.buckets.total)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  href,
  hint,
  alert,
}: {
  label: string;
  value: string;
  href: string;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <Link
      href={href}
      className="relative overflow-hidden rounded-lg border border-border bg-card p-4 shadow-[0_1px_2px_rgb(27_42_78/0.05)] hover:border-ring transition-colors"
    >
      <div className="absolute inset-y-0 left-0 w-[3px] bg-[var(--gw-gold)]" />
      <div className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1 truncate">{value}</div>
      {hint && <div className={`text-[11px] mt-1 ${alert ? "text-destructive" : "text-muted-foreground"}`}>{hint}</div>}
    </Link>
  );
}

function QuickLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}

function reviewSummary(review: Array<{ reason: string }>) {
  const n = (reason: string) => review.filter((r) => r.reason === reason).length;
  const parts = [`${n("agent_draft")} agent draft(s)`];
  if (n("recurring") > 0) parts.push(`${n("recurring")} recurring invoice(s)`);
  parts.push(`${n("awaiting_approval")} bill(s) awaiting approval`);
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}
