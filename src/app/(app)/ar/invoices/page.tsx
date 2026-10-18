import Link from "next/link";
import { format } from "date-fns";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listInvoices } from "@/lib/ar/invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { formatMoney, money } from "@/lib/money";

const FILTERS = [
  { key: "", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "open", label: "Open" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "voided", label: "Voided" },
] as const;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { status = "", q } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) =>
    listInvoices(ctx, {
      status:
        status === "draft" || status === "open" || status === "paid" || status === "voided"
          ? status
          : undefined,
      overdueOnly: status === "overdue",
      q,
      limit: 200,
    })
  );
  const today = format(new Date(), "yyyy-MM-dd");

  return (
    <AppShell
      title="Invoices"
      crumb={`${organization.name} · Sales`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key ? `/ar/invoices?status=${f.key}` : "/ar/invoices"}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs",
                  status === f.key
                    ? "bg-primary/15 text-primary font-semibold"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
          <div className="flex gap-2">
            <Link
              href="/ar/payments/new"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
            >
              Receive payment
            </Link>
            <Link
              href="/ar/invoices/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              New invoice
            </Link>
          </div>
        </div>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Invoice #</th>
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2 w-28">Due</th>
                <th className="text-right font-medium px-3 py-2 w-32">Total</th>
                <th className="text-right font-medium px-3 py-2 w-32">Balance</th>
                <th className="text-left font-medium px-3 py-2 w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No invoices{status ? ` (${status})` : ""} yet.
                  </td>
                </tr>
              )}
              {page.data.map((inv) => {
                const overdue = inv.status === "open" && inv.dueDate < today;
                return (
                  <tr key={inv.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/ar/invoices/${inv.id}`} className="text-primary hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{inv.customerName}</td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{inv.invoiceDate}</td>
                    <td className={cn("px-3 py-2 text-xs font-mono", overdue ? "text-destructive" : "text-muted-foreground")}>
                      {inv.dueDate}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(inv.totalAmount, { currency: inv.currency })}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {money(inv.openBalance).isZero()
                        ? "—"
                        : formatMoney(inv.openBalance, { currency: inv.currency })}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={overdue ? "overdue" : inv.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {page.hasMore && (
          <p className="text-[11px] text-muted-foreground">Showing the 200 most recent.</p>
        )}
      </div>
    </AppShell>
  );
}
