import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import {
  getIncomeStatement,
  type StatementSection,
  type StatementSubgroup,
} from "@/lib/gl/reports";
import { formatMoney } from "@/lib/money";
import { DateRangeFilter } from "../date-filter";

type SP = Promise<{ from?: string; to?: string }>;

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const ytdStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return { from: ytdStart, to: today };
}

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const defaults = defaultRange();
  const fromDate =
    params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from)
      ? params.from
      : defaults.from;
  const toDate =
    params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : defaults.to;

  const is = await getIncomeStatement(organization.id, { fromDate, toDate });

  return (
    <AppShell
      title="Income Statement"
      crumb={`${organization.name} · Reports`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-4xl">
        <DateRangeFilter fromValue={fromDate} toValue={toDate} />

        <div className="text-center">
          <div className="font-heading text-2xl tracking-[0.1em]">
            {organization.name.toUpperCase()}
          </div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mt-1">
            Income Statement
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {fromDate} to {toDate}
          </div>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <SectionBlock section={is.revenue} />
              <TotalRow
                label="Total Revenue"
                amount={formatMoney(is.revenue.total)}
              />
              <Spacer />

              <SectionBlock section={is.cogs} />
              <TotalRow
                label="Total COGS"
                amount={formatMoney(is.cogs.total)}
              />
              <TotalRow
                label="GROSS PROFIT"
                amount={formatMoney(is.grossProfit)}
                emphasize
              />
              <Spacer />

              <SectionBlock section={is.operatingExpenses} />
              <TotalRow
                label="Total Operating Expenses"
                amount={formatMoney(is.operatingExpenses.total)}
              />
              <TotalRow
                label="OPERATING INCOME"
                amount={formatMoney(is.operatingIncome)}
                emphasize
              />
              <Spacer />

              <SectionBlock section={is.otherIncomeExpense} />
              <TotalRow
                label="NET INCOME"
                amount={formatMoney(is.netIncome)}
                emphasize
              />
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

function SectionBlock({ section }: { section: StatementSection }) {
  if (section.subgroups.length === 0) {
    return (
      <tr>
        <td
          colSpan={3}
          className="px-3 py-2 text-xs text-muted-foreground italic"
        >
          No {section.label.toLowerCase()} activity in this range.
        </td>
      </tr>
    );
  }
  return (
    <>
      <tr className="bg-muted/50 border-t border-border">
        <td
          colSpan={3}
          className="px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold"
        >
          {section.label}
        </td>
      </tr>
      {section.subgroups.map((g) => (
        <SubgroupBlock key={g.subcategory} group={g} />
      ))}
    </>
  );
}

function SubgroupBlock({ group }: { group: StatementSubgroup }) {
  return (
    <>
      <tr className="border-t border-border">
        <td
          colSpan={3}
          className="px-3 py-1.5 text-xs font-medium text-foreground bg-background"
        >
          {group.label}
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.accountId} className="border-t border-border/50">
          <td className="px-3 py-1.5 w-24 font-mono text-[11px] text-primary pl-8">
            {r.code}
          </td>
          <td className="px-3 py-1.5 text-xs">{r.name}</td>
          <td className="px-3 py-1.5 text-right font-mono text-xs w-40">
            {formatMoney(r.displayAmount)}
          </td>
        </tr>
      ))}
      <tr className="border-t border-border/70">
        <td
          colSpan={2}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground pl-8"
        >
          Subtotal — {group.label}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-xs font-medium">
          {formatMoney(group.subtotal)}
        </td>
      </tr>
    </>
  );
}

function TotalRow({
  label,
  amount,
  emphasize,
}: {
  label: string;
  amount: string;
  emphasize?: boolean;
}) {
  if (emphasize) {
    return (
      <tr className="border-t-2 border-border bg-primary/5">
        <td
          colSpan={2}
          className="px-3 py-2 font-heading tracking-[0.1em] text-sm"
        >
          {label}
        </td>
        <td className="px-3 py-2 text-right font-mono text-sm font-semibold">
          {amount}
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-t border-border bg-muted/30">
      <td
        colSpan={2}
        className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </td>
      <td className="px-3 py-1.5 text-right font-mono text-xs font-medium">
        {amount}
      </td>
    </tr>
  );
}

function Spacer() {
  return (
    <tr>
      <td colSpan={3} className="h-4"></td>
    </tr>
  );
}
