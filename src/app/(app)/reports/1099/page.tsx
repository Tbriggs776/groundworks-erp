import Link from "next/link";
import { and, asc, eq, notInArray } from "drizzle-orm";
import { Download } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Input } from "@/components/ui/input";
import { hasRole, runAs } from "@/lib/actor";
import { default1099Threshold, form1099Report, FORM_1099_BOXES, type Form1099Box } from "@/lib/ap/form-1099";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { formatMoney, money } from "@/lib/money";
import { BoxMapping } from "./box-mapping";

const SHORT: Record<Form1099Box, string> = {
  nec_1: "NEC 1",
  misc_1: "MISC 1",
  misc_2: "MISC 2",
  misc_3: "MISC 3",
  misc_6: "MISC 6",
  misc_10: "MISC 10",
};

export default async function Form1099Page({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; threshold?: string; all?: string }>;
}) {
  const sp = await searchParams;
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const thisYear = new Date().getFullYear();
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : thisYear;
  const threshold = sp.threshold && /^\d+(\.\d{1,2})?$/.test(sp.threshold) ? sp.threshold : undefined;
  const showAll = sp.all === "1";
  const report = await runAs(actor, (ctx) => form1099Report(ctx, { year, threshold, reportableOnly: !showAll }));
  const expenseAccounts = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, box: accounts.form1099Box })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organization.id),
        eq(accounts.category, "income_statement"),
        eq(accounts.normalBalance, "debit"),
        // Contra-revenue (sales discounts) is debit-normal but isn't an expense.
        notInArray(accounts.subcategory, ["operating_revenue", "other_revenue"]),
        eq(accounts.accountType, "posting"),
        eq(accounts.isActive, true)
      )
    )
    .orderBy(asc(accounts.code));
  const used = FORM_1099_BOXES.filter((b) => report.vendors.some((v) => money(v.boxes[b]).gt(0)) || b === "nec_1");
  const fmt = (v: string) => formatMoney(v);
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { year: String(year), threshold, all: showAll ? "1" : undefined, ...o };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/reports/1099?${p.toString()}`;
  };
  const exportQs = new URLSearchParams({ year: String(year), ...(threshold ? { threshold } : {}) }).toString();
  const canExport = hasRole(role, "accountant");
  const issues = report.vendors.filter((v) => v.issues.length > 0).length;

  return (
    <AppShell title="1099 Report" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <form className="flex flex-wrap items-end gap-3" action="/reports/1099">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Tax year</div>
              <select name="year" defaultValue={String(year)} className="text-sm bg-background border border-border rounded-md px-2 py-2" aria-label="Tax year">
                {[thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Threshold</div>
              <Input name="threshold" defaultValue={threshold ?? ""} placeholder={default1099Threshold(year)} className="w-28 font-mono" aria-label="Threshold" />
            </div>
            {showAll && <input type="hidden" name="all" value="1" />}
            <button type="submit" className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-accent">
              Run
            </button>
          </form>
          <div className="flex items-center gap-3">
            <Link href={qs({ all: showAll ? undefined : "1" })} className="text-xs text-primary hover:underline">
              {showAll ? "Only vendors that get a 1099" : "Show every vendor paid on 1099 accounts"}
            </Link>
            <a
              href={`/reports/export/1099?format=pdf&${exportQs}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
            >
              PDF summary
            </a>
            {canExport && (
              <a
                href={`/reports/1099/export?${exportQs}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </a>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Paid in {year}, by payment date, on accounts mapped to a 1099 box below. Card payments are left out (the card company reports them
          on a 1099-K). Threshold {fmt(report.threshold)}; royalties report from $10.
          {issues > 0 && <span className="text-destructive"> {issues} vendor{issues === 1 ? " needs" : "s need"} attention before filing.</span>}
        </p>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-left font-medium px-3 py-2 w-24">TIN</th>
                <th className="text-left font-medium px-3 py-2 w-14">W-9</th>
                {used.map((b) => (
                  <th key={b} className="text-right font-medium px-3 py-2 w-28" title={report.boxLabels[b]}>{SHORT[b]}</th>
                ))}
                <th className="text-right font-medium px-3 py-2 w-28">Total</th>
              </tr>
            </thead>
            <tbody>
              {report.vendors.length === 0 && (
                <tr>
                  <td colSpan={4 + used.length} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No vendor reaches the threshold for {year}. Mark vendors as 1099 vendors on the Vendors page and map accounts below.
                  </td>
                </tr>
              )}
              {report.vendors.map((v) => (
                <tr key={v.vendorId} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <div>{v.name}</div>
                    {!v.reportable && <div className="text-[11px] text-muted-foreground">{v.is1099Vendor ? "Below the threshold" : "Not a 1099 vendor"}</div>}
                    {v.issues.map((i) => (
                      <div key={i} className="text-[11px] text-destructive">{i}</div>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{v.tinLast4 ? `•••${v.tinLast4}` : "—"}</td>
                  <td className="px-3 py-2 text-xs">{v.w9OnFile ? "Yes" : "No"}</td>
                  {used.map((b) => (
                    <td key={b} className="px-3 py-2 text-right font-mono text-xs">{money(v.boxes[b]).gt(0) ? fmt(v.boxes[b]) : "—"}</td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold">{fmt(v.total)}</td>
                </tr>
              ))}
            </tbody>
            {report.vendors.some((v) => v.reportable) && (
              <tfoot className="bg-muted/30">
                <tr className="border-t-2 border-border">
                  <td colSpan={3} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Reportable total</td>
                  {used.map((b) => (
                    <td key={b} className="px-3 py-2 text-right font-mono text-xs font-semibold">{fmt(report.totals[b])}</td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                    {fmt(FORM_1099_BOXES.reduce((acc, b) => acc.plus(money(report.totals[b])), money(0)).toFixed(2))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Accounts and 1099 boxes</div>
          <p className="text-xs text-muted-foreground">Payments to 1099 vendors on an account count in its box.{!canExport && " Accountants and up can change these."}</p>
          <BoxMapping accounts={expenseAccounts} labels={report.boxLabels} canEdit={canExport} />
        </div>
      </div>
    </AppShell>
  );
}
