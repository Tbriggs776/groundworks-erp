import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { apBills, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  pending_approval: "secondary",
  rejected: "destructive",
  approved: "secondary",
  posted: "default",
  paid: "default",
  voided: "outline",
};

export default async function BillsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select({ bill: apBills, vendor: vendors })
    .from(apBills)
    .innerJoin(vendors, eq(vendors.id, apBills.vendorId))
    .where(
      and(
        eq(apBills.organizationId, organization.id),
        isNull(apBills.deletedAt)
      )
    )
    .orderBy(desc(apBills.updatedAt));

  return (
    <AppShell
      title="AP Bills"
      crumb={`${organization.name} · Procurement`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} bill{rows.length === 1 ? "" : "s"}.
          </div>
          <Link
            href="/ap/bills/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New bill
          </Link>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Bill #</th>
                <th className="text-left font-medium px-3 py-2 w-28">Vendor inv</th>
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-left font-medium px-3 py-2 w-28">Bill date</th>
                <th className="text-left font-medium px-3 py-2 w-28">Due</th>
                <th className="text-right font-medium px-3 py-2 w-36">Total</th>
                <th className="text-left font-medium px-3 py-2 w-32">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No AP bills yet.
                  </td>
                </tr>
              )}
              {rows.map(({ bill, vendor }) => (
                <tr key={bill.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/ap/bills/${bill.id}`}
                      className="text-primary hover:underline"
                    >
                      {bill.billNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
                    {bill.vendorInvoiceNumber ?? "—"}
                  </td>
                  <td className="px-3 py-2">{vendor.name}</td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                    {bill.billDate}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                    {bill.dueDate}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(bill.totalAmount, { currency: bill.currency })}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={STATUS_STYLE[bill.status] ?? "outline"}
                      className="text-[9px] capitalize"
                    >
                      {bill.status.replace(/_/g, " ")}
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
