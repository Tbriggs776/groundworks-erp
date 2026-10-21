import { sql } from "drizzle-orm";
import { estimateLines, estimates, purchaseOrderLines, purchaseOrders } from "@/lib/db/schema";
import { auditFields, creatorFields } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import type { QboRecord } from "../client";
import { pagedStep, type Kit, type Ref } from "./kit";
import { currencyOf, dateOf, docNumber, importTxn, purchaseLines, salesLines, salesTax, salesTotals, text } from "./txn";

/**
 * Estimates and purchase orders: documents that never touch the ledger.
 * They come across before invoices and bills, so an invoice can point at
 * the estimate it billed and a bill line at the purchase order line it
 * billed, as QuickBooks linked them.
 */

const audit = (kit: Kit, event: string, entityType: string, entityId: string, metadata: Record<string, unknown>) =>
  writeAudit({ organizationId: kit.org, ...auditFields(kit.ctx.actor), event, entityType, entityId, metadata }, kit.ctx.tx);

const ESTIMATE_STATUS: Record<string, "pending" | "accepted" | "rejected" | "closed"> = {
  Pending: "pending",
  Accepted: "accepted",
  Rejected: "rejected",
  Closed: "closed",
  Converted: "closed",
};

export const estimatesStep = pagedStep({
  key: "estimates",
  label: "Estimates",
  entity: "Estimate",
  preload: ["Customer", "Item", "Account", "Class", "Department", "TaxRate", "TaxCode"],
  async importOne(kit, r) {
    const label = `Estimate ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "Estimate", r, label, async () => {
      const customerId = await kit.local("Customer", r.CustomerRef as Ref);
      if (!customerId) throw new AppError("invalid_input", `its customer ${(r.CustomerRef as Ref)?.name ?? ""} isn't here.`);
      const lines = await salesLines(kit, r, label);
      const tax = await salesTax(kit, r, lines, label);
      const { subtotalAmount, taxCodeId, taxExempt, taxableAmount, taxAmount, totalAmount } = salesTotals(kit, label, r, lines, tax);
      const estimateNumber = await docNumber(kit, "Estimate", "estimates", "estimate_number", r.DocNumber, "EST");
      const [e] = await kit.ctx.tx
        .insert(estimates)
        .values({
          organizationId: kit.org,
          estimateNumber,
          customerId,
          estimateDate: dateOf(r),
          expirationDate: text(r.ExpirationDate, 10),
          ...(await currencyOf(kit, r)),
          subtotalAmount,
          taxCodeId,
          taxExempt,
          taxableAmount,
          taxAmount,
          totalAmount,
          memo: text((r.CustomerMemo as { value?: string } | undefined)?.value, 2000),
          privateNote: text(r.PrivateNote, 2000),
          status: ESTIMATE_STATUS[String(r.TxnStatus)] ?? "pending",
          acceptedBy: text(r.AcceptedBy, 200),
          acceptedDate: text(r.AcceptedDate, 10),
          ...creatorFields(kit.ctx.actor),
        })
        .returning();
      await kit.ctx.tx.insert(estimateLines).values(lines.map((l, i) => ({ organizationId: kit.org, estimateId: e.id, lineNumber: i + 1, ...l })));
      await audit(kit, "ar.estimate.created", "estimate", e.id, { estimateNumber, total: e.totalAmount, importedFrom: "quickbooks" });
      await kit.remember("Estimate", r.Id, e.id);
    });
  },
});

export const purchaseOrdersStep = pagedStep({
  key: "purchase_orders",
  label: "Purchase orders",
  entity: "PurchaseOrder",
  preload: ["Vendor", "Customer", "Item", "Account", "Class", "Department"],
  async importOne(kit, r) {
    const label = `Purchase order ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "PurchaseOrder", r, label, async () => {
      const vendorId = await kit.local("Vendor", r.VendorRef as Ref);
      if (!vendorId) throw new AppError("invalid_input", `its vendor ${(r.VendorRef as Ref)?.name ?? ""} isn't here.`);
      // A purchase order line is always for more than zero.
      const all = await purchaseLines(kit, r, label, "in");
      const lines = all.filter((l) => money(l.amount).gt(0));
      if (lines.length < all.length) kit.note(`${label}: lines of zero or less didn't come across (a purchase order line is for more than zero).`);
      if (lines.length === 0) throw new AppError("invalid_input", "it has no lines for more than zero.");
      const closed = r.POStatus === "Closed";
      const poNumber = await docNumber(kit, "Purchase order", "purchase_orders", "po_number", r.DocNumber, "PO");
      const [po] = await kit.ctx.tx
        .insert(purchaseOrders)
        .values({
          organizationId: kit.org,
          poNumber,
          vendorId,
          poDate: dateOf(r),
          expectedDate: text(r.DueDate, 10),
          ...(await currencyOf(kit, r)),
          totalAmount: toDbMoney(sumMoney(lines.map((l) => l.amount))),
          vendorMessage: text(r.Memo, 2000),
          memo: text(r.PrivateNote, 2000),
          // Approved in QuickBooks.
          status: closed ? "closed" : "open",
          approvedAt: sql`now()`,
          approvedBy: kit.ctx.actor.userId,
          ...(closed ? { closedAt: sql`now()`, closedBy: kit.ctx.actor.userId, closeReason: "Closed in QuickBooks" } : {}),
          ...creatorFields(kit.ctx.actor),
        })
        .returning();
      const rows = await kit.ctx.tx
        .insert(purchaseOrderLines)
        .values(
          lines.map((l, i) => {
            const qty = l.quantity ? money(l.quantity) : money(1);
            return {
              organizationId: kit.org,
              purchaseOrderId: po.id,
              lineNumber: i + 1,
              itemId: l.itemId,
              accountId: l.accountId,
              description: l.description,
              quantity: toDbMoney(qty),
              unitCost: l.unitCost ?? toDbMoney(money(l.amount).div(qty)),
              amount: l.amount,
            };
          })
        )
        .returning({ id: purchaseOrderLines.id });
      for (const [i, l] of lines.entries()) {
        if (l.qboLineId) await kit.remember("PurchaseOrderLine", `${r.Id}:${l.qboLineId}`, rows[i].id);
      }
      await audit(kit, "ap.purchase_order.created", "purchase_order", po.id, { poNumber, total: po.totalAmount, importedFrom: "quickbooks" });
      await kit.remember("PurchaseOrder", r.Id, po.id);
    });
  },
});

/** The purchase order a bill billed: QuickBooks links it on the bill or on its lines. */
export async function purchaseOrderOf(kit: Kit, r: QboRecord, lines: Array<{ poLine: string | null }>): Promise<string | null> {
  const linked = (r.LinkedTxn as Array<{ TxnId?: string; TxnType?: string }> | undefined)?.find((t) => t.TxnType === "PurchaseOrder")?.TxnId;
  const fromLine = lines.find((l) => l.poLine)?.poLine?.split(":")[0];
  const qboId = linked ?? fromLine;
  return qboId ? kit.local("PurchaseOrder", { value: qboId }) : null;
}
