import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { hasRole, runAs } from "@/lib/actor";
import { getPurchaseOrder } from "@/lib/ap/purchase-orders";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { EmailButton } from "@/app/(app)/_email/email-button";
import { EmailHistory } from "@/app/(app)/_email/email-history";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { addressLines } from "@/lib/pdf/templates";
import { creatorOf } from "@/lib/ui/creator";
import { PdfLink } from "../../../ar/doc-view";
import { lotChoices } from "@/lib/ui/form-data";
import { PurchaseOrderActions } from "./po-actions";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const canEmail = hasRole(actor.role, "bookkeeper") && !actor.support;
  const po = await runAs(actor, (ctx) => getPurchaseOrder(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  const creator = await creatorOf(po);
  const fmt = (v: string) => formatMoney(v, { currency: po.currency });
  const anyBilled = money(po.billedAmount).gt(0) || po.bills.length > 0;
  const shipTo = addressLines(po.shipTo);

  return (
    <AppShell title={`Purchase Order ${po.poNumber}`} crumb={`${organization.name} · Expenses · Purchase Orders`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{po.poNumber}</div>
            <div className="text-sm mt-1">{po.vendorName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>Ordered {po.poDate}</span>
              {po.expectedDate && (
                <>
                  <span>·</span>
                  <span>Expected {po.expectedDate}</span>
                </>
              )}
              <StatusBadge status={po.status} />
              {po.sentAt && <span>Sent {format(po.sentAt, "yyyy-MM-dd")}</span>}
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <PurchaseOrderActions
              po={{
                id: po.id,
                poNumber: po.poNumber,
                status: po.status,
                currency: po.currency,
                remainingAmount: po.remainingAmount,
                sent: Boolean(po.sentAt),
                hasBills: po.bills.length > 0,
              }}
              lines={po.lines.map((l) => ({
                id: l.id,
                lineNumber: l.lineNumber,
                label: l.description ?? l.itemName ?? "Line",
                amount: l.amount,
                remaining: l.remaining,
                unitCost: l.unitCost,
                remainingQuantity: l.remainingQuantity,
                itemId: l.itemType === "inventory" ? l.itemId : null,
              }))}
              lots={await lotChoices(organization.id)}
              canApprove={hasRole(role, "accountant")}
            />
            <div className="flex gap-2">
              {canEmail && (po.status === "open" || po.status === "closed") && <EmailButton documentType="purchase_order" documentId={po.id} />}
            </div>
            <PdfLink kind="purchase-order" id={po.id} />
            <Link href="/ap/purchase-orders" className="text-xs text-muted-foreground hover:text-foreground">← Back to purchase orders</Link>
          </div>
        </div>

        {po.status === "rejected" && po.rejectionReason && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">Rejected</span>: {po.rejectionReason}. Edit it and submit again.
          </div>
        )}
        {po.status === "closed" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">Closed</span>
            {po.closeReason ? `: ${po.closeReason}` : ": fully billed"}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Ship to</div>
            {shipTo.length ? shipTo.map((l) => <div key={l}>{l}</div>) : <div className="text-muted-foreground">No address</div>}
          </div>
          {po.vendorMessage && (
            <div className="rounded-md border border-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Message to vendor</div>
              <div className="whitespace-pre-wrap">{po.vendorMessage}</div>
            </div>
          )}
        </div>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-10">#</th>
                <th className="text-left font-medium px-3 py-2">Product / service</th>
                <th className="text-left font-medium px-3 py-2 w-48">Account</th>
                <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
                <th className="text-right font-medium px-3 py-2 w-28">Unit cost</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                {anyBilled && <th className="text-right font-medium px-3 py-2 w-28">Billed</th>}
                {anyBilled && <th className="text-right font-medium px-3 py-2 w-28">Left</th>}
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
                  <td className="px-3 py-2">
                    {l.itemName && <div className="text-sm">{l.itemName}</div>}
                    {l.description && l.description !== l.itemName && <div className="text-xs text-muted-foreground">{l.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className="font-mono text-muted-foreground">{l.accountCode}</span> {l.accountName}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{money(l.quantity).toString()}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.unitCost)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                  {anyBilled && (
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {fmt(l.billed)}
                      {money(l.billedQuantity).gt(0) && (
                        <div className="text-[10px] text-muted-foreground">{money(l.billedQuantity).toString()} received</div>
                      )}
                    </td>
                  )}
                  {anyBilled && <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.remaining)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30">
              <Foot cols={anyBilled ? 8 : 6} label="Total" value={fmt(po.totalAmount)} strong first />
              {anyBilled && <Foot cols={8} label="Billed" value={fmt(po.billedAmount)} />}
              {anyBilled && <Foot cols={8} label="Left to bill" value={fmt(po.remainingAmount)} strong />}
            </tfoot>
          </table>
        </div>

        {po.bills.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Bills from this purchase order</div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {po.bills.map((b) => (
                    <tr key={b.id} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/ap/bills/${b.id}`} className="text-primary hover:underline">{b.billNumber}</Link>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{b.billDate}</td>
                      <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(b.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {po.memo && (
          <div className="text-xs">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Memo (internal)</div>
            <div className="whitespace-pre-wrap">{po.memo}</div>
          </div>
        )}
        <EmailHistory actor={actor} documentType="purchase_order" documentId={po.id} />
        <AttachmentsSection entityType="purchase_order" entityId={id} />
      </div>
    </AppShell>
  );
}

function Foot({ cols, label, value, strong, first }: { cols: number; label: string; value: string; strong?: boolean; first?: boolean }) {
  return (
    <tr className={first ? "border-t-2 border-border" : undefined}>
      <td colSpan={cols - 1} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">{label}</td>
      <td className={`px-3 py-1 text-right font-mono ${strong ? "text-sm font-semibold" : "text-xs"}`}>{value}</td>
    </tr>
  );
}
