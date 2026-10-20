"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as billPayments from "@/lib/ap/bill-payments";
import * as bills from "@/lib/ap/bills";
import * as purchaseOrders from "@/lib/ap/purchase-orders";
import * as vendorCredits from "@/lib/ap/vendor-credits";
import * as vendorRefunds from "@/lib/ap/vendor-refunds";
import * as invoices from "@/lib/ar/invoices";
import * as creditMemos from "@/lib/ar/credit-memos";
import * as customerPayments from "@/lib/ar/payments";
import * as refunds from "@/lib/ar/refunds";
import * as salesReceipts from "@/lib/ar/sales-receipts";
import * as bankTxns from "@/lib/banking/transactions";
import * as journals from "@/lib/gl/journals";
import type { ReviewItem } from "@/lib/review";

/**
 * One-click approvals from the review queue. Each maps to the same service
 * call the document's own page uses, so every rule still applies.
 */
export async function approveItem(type: ReviewItem["type"], id: string, status: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    switch (type) {
      case "invoice":
        return { id: (await invoices.postInvoice(ctx, { id })).id };
      case "customer_payment":
        return { id: (await customerPayments.postCustomerPayment(ctx, { id })).id };
      case "bill_payment":
        return { id: (await billPayments.postBillPayment(ctx, { id })).id };
      case "journal_entry":
        return { id: (await journals.postJournalEntry(ctx, { id })).id };
      case "bank_transaction":
        return { id: (await bankTxns.postBankTransaction(ctx, { id })).id };
      case "sales_receipt":
        return { id: (await salesReceipts.postSalesReceipt(ctx, { id })).id };
      case "credit_memo":
        return { id: (await creditMemos.postCreditMemo(ctx, { id })).id };
      case "refund_receipt":
        return { id: (await refunds.postRefund(ctx, { id })).id };
      case "vendor_credit":
        return { id: (await vendorCredits.postVendorCredit(ctx, { id })).id };
      case "vendor_refund":
        return { id: (await vendorRefunds.postVendorRefund(ctx, { id })).id };
      case "purchase_order": {
        // Submitting approves it at once when this person's role allows.
        if (status === "draft") {
          const po = await purchaseOrders.submitPurchaseOrder(ctx, { id });
          if (po.status === "open") return { id };
        }
        return { id: (await purchaseOrders.approvePurchaseOrder(ctx, { id })).id };
      }
      case "bill":
        // Walk the bill as far as this person may take it.
        if (status === "draft") await bills.submitBill(ctx, { id });
        if (status === "draft" || status === "pending_approval") await bills.approveBill(ctx, { id });
        return { id: (await bills.postBill(ctx, { id })).id };
    }
  });
  revalidatePath("/review");
  revalidatePath("/dashboard");
  return r;
}

export async function dismissItem(type: ReviewItem["type"], id: string, status: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    switch (type) {
      case "invoice":
        return invoices.deleteDraftInvoice(ctx, { id });
      case "customer_payment":
        return customerPayments.deleteDraftCustomerPayment(ctx, { id });
      case "bill_payment":
        return billPayments.deleteDraftBillPayment(ctx, { id });
      case "journal_entry":
        return journals.deleteDraftJournal(ctx, { id });
      case "bank_transaction":
        return bankTxns.deleteDraftBankTransaction(ctx, { id });
      case "sales_receipt":
        return salesReceipts.deleteDraftSalesReceipt(ctx, { id });
      case "credit_memo":
        return creditMemos.deleteDraftCreditMemo(ctx, { id });
      case "refund_receipt":
        return refunds.deleteDraftRefund(ctx, { id });
      case "vendor_credit":
        return vendorCredits.deleteDraftVendorCredit(ctx, { id });
      case "vendor_refund":
        return vendorRefunds.deleteDraftVendorRefund(ctx, { id });
      case "purchase_order":
        if (status === "pending_approval") {
          return { id: (await purchaseOrders.rejectPurchaseOrder(ctx, { id, reason: "Rejected from the review queue" })).id };
        }
        return purchaseOrders.deleteDraftPurchaseOrder(ctx, { id });
      case "bill":
        if (status === "pending_approval") {
          return { id: (await bills.rejectBill(ctx, { id, reason: "Rejected from the review queue" })).id };
        }
        return bills.deleteDraftBill(ctx, { id });
    }
  });
  revalidatePath("/review");
  return r;
}
