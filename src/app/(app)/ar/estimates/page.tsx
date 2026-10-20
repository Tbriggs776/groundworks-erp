import Link from "next/link";
import { format } from "date-fns";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { ESTIMATE_STATUSES, listEstimates } from "@/lib/ar/estimates";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";
import { cn } from "@/lib/utils";

const FILTERS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "accepted", label: "Accepted" },
  { key: "closed", label: "Closed" },
  { key: "rejected", label: "Rejected" },
] as const;

export default async function EstimatesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const { status = "", q } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const filter = ESTIMATE_STATUSES.find((s) => s === status);
  const page = await runAs(actor, (ctx) => listEstimates(ctx, { status: filter, q, limit: 200 }));
  const today = format(new Date(), "yyyy-MM-dd");

  return (
    <AppShell title="Estimates" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key ? `/ar/estimates?status=${f.key}` : "/ar/estimates"}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs",
                  status === f.key ? "bg-primary/15 text-primary font-semibold" : "text-muted-foreground hover:bg-accent"
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
          <Link
            href="/ar/estimates/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New estimate
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-left font-medium px-3 py-2 w-28">Expires</th>
                <th className="text-right font-medium px-3 py-2 w-32">Total</th>
                <th className="text-right font-medium px-3 py-2 w-40">Billed</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No estimates yet. Quote a customer, then bill it all at once or in parts.
                  </td>
                </tr>
              )}
              {page.data.map((e) => {
                const expired = e.status === "pending" && e.expirationDate && e.expirationDate < today;
                const billedPct = money(e.subtotalAmount).gt(0) ? money(e.billedAmount).div(money(e.subtotalAmount)).times(100).toFixed(0) : "0";
                return (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/ar/estimates/${e.id}`} className="text-primary hover:underline">{e.estimateNumber}</Link>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{e.estimateDate}</td>
                    <td className="px-3 py-2">{e.customerName}</td>
                    <td className={cn("px-3 py-2 text-xs font-mono", expired ? "text-destructive" : "text-muted-foreground")}>{e.expirationDate ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(e.totalAmount, { currency: e.currency })}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {money(e.billedAmount).isZero() ? "—" : `${formatMoney(e.billedAmount, { currency: e.currency })} (${billedPct}%)`}
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">Billed is before sales tax, so a fully billed estimate shows its subtotal.</p>
      </div>
    </AppShell>
  );
}
