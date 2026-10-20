"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as billPayments from "@/lib/ap/bill-payments";
import * as bills from "@/lib/ap/bills";
import * as invoices from "@/lib/ar/invoices";
import * as customerPayments from "@/lib/ar/payments";
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
