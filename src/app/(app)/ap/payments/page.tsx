import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { apPayments, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

const STATUS_STYLE: Record<string, "default" | "secondary" | "outline" | "destructive"> =
  {
    draft: "outline",
    posted: "default",
    voided: "outline",
  };

const METHOD_LABEL: Record<string, string> = {
  check: "Check",
  ach: "ACH",
  wire: "Wire",
  credit_card: "Credit card",
  cash: "Cash",
  other: "Other",
};

export default async function PaymentsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select({ p: apPayments, v: vendors })
    .from(apPayments)
    .innerJoin(vendors, eq(vendors.id, apPayments.vendorId))
    .where(
      and(
        eq(apPayments.organizationId, organization.id),
        isNull(apPayments.deletedAt)
      )
    )
    .orderBy(desc(apPayments.updatedAt));

  return (
    <AppShell
      title="AP Payments"
      crumb={`${organization.name} · Procurement`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} payment{rows.length === 1 ? "" : "s"}.
          </div>
          <Link
            href="/ap/payments/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New payment
          </Link>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-32">Payment #</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-left font-medium px-3 py-2 w-28">Method</th>
                <th className="text-left font-medium px-3 py-2 w-28">Reference</th>
                <th className="text-right font-medium px-3 py-2 w-32">Net</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No payments yet.
                  </td>
                </tr>
              )}
              {rows.map(({ p, v }) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/ap/payments/${p.id}`}
                      className="text-primary hover:underline"
                    >
                      {p.paymentNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                    {p.paymentDate}
                  </td>
                  <td className="px-3 py-2">{v.name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {METHOD_LABEL[p.method] ?? p.method}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                    {p.reference ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(p.netAmount, { currency: p.currency })}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={STATUS_STYLE[p.status] ?? "outline"}
                      className="text-[9px] capitalize"
                    >
                      {p.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
