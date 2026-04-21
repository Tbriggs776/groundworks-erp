import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import {
  getBalanceSheet,
  type StatementSection,
  type StatementSubgroup,
} from "@/lib/gl/reports";
import { formatMoney } from "@/lib/money";
import { DateFilter } from "../date-filter";

type SP = Promise<{ asOf?: string }>;

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const asOfDate =
    params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf)
      ? params.asOf
      : new Date().toISOString().slice(0, 10);

  const bs = await getBalanceSheet(organization.id, asOfDate);

  return (
    <AppShell
      title="Balance Sheet"
      crumb={`${organization.name} · Reports`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-4xl">
        <DateFilter paramName="asOf" value={asOfDate} label="As of" />

        <div className="text-center">
          <div className="font-heading text-2xl tracking-[0.1em]">
            {organization.name.toUpperCase()}
          </div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mt-1">
            Balance Sheet
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            as of {asOfDate}
          </div>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <SectionBlock section={bs.assets} />
              <TotalRow label="TOTAL ASSETS" amount={formatMoney(bs.assets.total)} emphasize />
              <Spacer />

              <SectionBlock section={bs.liabilities} />
              <TotalRow
                label="Total Liabilities"
                amount={formatMoney(bs.liabilities.total)}
              />

              <SectionBlock section={bs.equity} />
              <TotalRow
                label="Total Equity"
                amount={formatMoney(bs.equity.total)}
              />

              <TotalRow
                label="TOTAL LIABILITIES + EQUITY"
                amount={formatMoney(bs.liabilities.total.plus(bs.equity.total))}
                emphasize
              />
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-3">
          {bs.outOfBalance.isZero() ? (
            <span className="text-xs uppercase tracking-wider text-[var(--gw-green-bright)]">
              ✓ Balanced (Assets = Liabilities + Equity)
            </span>
          ) : (
            <span className="text-xs uppercase tracking-wider text-destructive">
              OUT OF BALANCE: Δ {formatMoney(bs.outOfBalance.abs())}
            </span>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SectionBlock({ section }: { section: StatementSection }) {
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
        <td colSpan={2} className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground pl-8">
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
