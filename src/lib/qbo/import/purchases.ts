import { eq, sql } from "drizzle-orm";
import { apBillLines, apBills, bankTransactionLines, bankTransactions, vendorCreditLines, vendorCredits } from "@/lib/db/schema";
import { creatorFields } from "@/lib/actor";
import { postBill } from "@/lib/ap/bills";
import { postVendorCredit } from "@/lib/ap/vendor-credits";
import { postBankTransactionToGl } from "@/lib/banking/posting";
import { AppError } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import type { QboRecord } from "../client";
import { pagedStep, type Kit, type Ref } from "./kit";
import { purchaseOrderOf } from "./orders";
import {
  amountOf,
  auditVoided,
  checkTotal,
  currencyOf,
  dateOf,
  importTxn,
  isVoided,
  later,
  methodOf,
  purchaseLines,
  text,
  voidedAt,
  type PaymentMethod,
} from "./txn";

/**
 * Purchase history: bills, vendor credits, expenses and checks (and card
 * charges and credits), and transfers. Bills come in approved and posted:
 * they were approved in QuickBooks. Lines keep QuickBooks' amounts, class,
 * and department; inventory items move stock as the app's own documents do.
 */

const PRELOAD = ["Vendor", "Customer", "Item", "Account", "Class", "Department", "PaymentMethod", "PurchaseOrder", "PurchaseOrderLine"];
const VOID_REASON = "Voided in QuickBooks";

async function vendorOf(kit: Kit, r: QboRecord): Promise<string> {
  const ref = r.VendorRef as Ref;
  const id = await kit.local("Vendor", ref);
  if (!id) throw new AppError("invalid_input", `its vendor ${ref?.name ?? ""} isn't here.`.replace("  ", " "));
  return id;
}

const posted = (kit: Kit, journalId: string) => ({ postedAt: sql`now()`, postedBy: kit.ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` });

export const billsStep = pagedStep({
  key: "bills",
  label: "Bills",
  entity: "Bill",
  preload: PRELOAD,
  async importOne(kit, r) {
    const label = `Bill ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "Bill", r, label, async () => {
      const vendorId = await vendorOf(kit, r);
      const lines = await purchaseLines(kit, r, label, "in");
      const total = sumMoney(lines.map((l) => l.amount));
      checkTotal(kit, label, total, r.TotalAmt);
      const date = dateOf(r);
      await kit.year(date);
      const [bill] = await kit.ctx.tx
        .insert(apBills)
        .values({
          organizationId: kit.org,
          purchaseOrderId: await purchaseOrderOf(kit, r, lines),
          billNumber: await nextNumber(kit.ctx.tx, kit.org, "AP"),
          vendorInvoiceNumber: text(r.DocNumber, 100),
          vendorId,
          billDate: date,
          dueDate: later(String(r.DueDate ?? date), date),
          postingDate: date,
          ...(await currencyOf(kit, r)),
          subtotalAmount: toDbMoney(total),
          totalAmount: toDbMoney(total),
          status: "approved",
          approvedAt: sql`now()`,
          approvedBy: kit.ctx.actor.userId,
          description: text(r.PrivateNote, 500),
          notes: "Approved in QuickBooks.",
          ...creatorFields(kit.ctx.actor),
        })
        .returning();
      const poLines = await Promise.all(lines.map((l) => (l.poLine ? kit.local("PurchaseOrderLine", { value: l.poLine }) : null)));
      await kit.ctx.tx.insert(apBillLines).values(
        lines.map((l, i) => ({
          organizationId: kit.org,
          billId: bill.id,
          lineNumber: i + 1,
          accountId: l.accountId,
          amount: l.amount,
          description: l.description,
          itemId: l.itemId,
          quantity: l.quantity,
          unitCost: l.unitCost,
          dimensions: l.dimensions,
          purchaseOrderLineId: poLines[i],
        }))
      );
      if (total.isZero()) {
        await kit.ctx.tx.update(apBills).set({ status: "paid", paidAt: sql`now()` }).where(eq(apBills.id, bill.id));
      } else {
        await postBill(kit.ctx, { id: bill.id });
      }
      await kit.remember("Bill", r.Id, bill.id);
    });
  },
});

export const vendorCreditsStep = pagedStep({
  key: "vendor_credits",
  label: "Vendor credits",
  entity: "VendorCredit",
  preload: PRELOAD,
  async importOne(kit, r) {
    const label = `Vendor credit ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "VendorCredit", r, label, async () => {
      const vendorId = await vendorOf(kit, r);
      const lines = await purchaseLines(kit, r, label, "out");
      const total = sumMoney(lines.map((l) => l.amount));
      checkTotal(kit, label, total, r.TotalAmt);
      const date = dateOf(r);
      await kit.year(date);
      const creditNumber = await nextNumber(kit.ctx.tx, kit.org, "VC");
      const [c] = await kit.ctx.tx
        .insert(vendorCredits)
        .values({
          organizationId: kit.org,
          creditNumber,
          vendorId,
          creditDate: date,
          vendorReference: text(r.DocNumber, 100),
          ...(await currencyOf(kit, r)),
          totalAmount: toDbMoney(total),
          memo: text(r.PrivateNote, 2000),
          status: "draft",
          ...creatorFields(kit.ctx.actor),
        })
        .returning();
      await kit.ctx.tx
        .insert(vendorCreditLines)
        .values(
          lines.map((l, i) => ({
            organizationId: kit.org,
            vendorCreditId: c.id,
            lineNumber: i + 1,
            accountId: l.accountId,
            amount: l.amount,
            description: l.description,
            itemId: l.itemId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            dimensions: l.dimensions,
          }))
        );
      if (total.isZero()) {
        await kit.ctx.tx.update(vendorCredits).set({ status: "applied", postedAt: sql`now()` }).where(eq(vendorCredits.id, c.id));
      } else {
        await postVendorCredit(kit.ctx, { id: c.id });
      }
      await kit.remember("VendorCredit", r.Id, c.id);
    });
  },
});

/** A bank transaction written like the app writes one, then posted (or voided, with zero amounts). */
export async function insertBankTxn(
  kit: Kit,
  r: QboRecord,
  header: Omit<typeof bankTransactions.$inferInsert, "organizationId" | "txnNumber" | "totalAmount" | "status">,
  lines: Array<Omit<typeof bankTransactionLines.$inferInsert, "organizationId" | "transactionId" | "lineNumber">>,
  series: "EXP" | "DEP" | "XFER",
  voided = false
) {
  const total = voided ? money(0) : sumMoney(lines.map((l) => l.amount));
  const [txn] = await kit.ctx.tx
    .insert(bankTransactions)
    .values({
      ...header,
      organizationId: kit.org,
      txnNumber: await nextNumber(kit.ctx.tx, kit.org, series),
      totalAmount: toDbMoney(total),
      status: voided ? "voided" : "draft",
      ...(voided ? { voidedAt: voidedAt(r), voidedBy: kit.ctx.actor.userId, voidReason: VOID_REASON } : {}),
      ...creatorFields(kit.ctx.actor),
    })
    .returning();
  if (voided) {
    await auditVoided(kit, "bank_transaction", txn.id, txn.reference ?? txn.txnNumber);
    return txn;
  }
  await kit.year(txn.txnDate);
  const rows = lines.length
    ? await kit.ctx.tx
        .insert(bankTransactionLines)
        .values(lines.map((l, i) => ({ ...l, organizationId: kit.org, transactionId: txn.id, lineNumber: i + 1 })))
        .returning()
    : [];
  const { journalId } = await postBankTransactionToGl(kit.ctx, txn, rows);
  await kit.ctx.tx.update(bankTransactions).set({ status: "posted", ...posted(kit, journalId) }).where(eq(bankTransactions.id, txn.id));
  return txn;
}

type EntityRef = { value?: string; name?: string; type?: string };

/** Expenses, checks, and card charges; a card credit comes back in as a deposit on the card. */
export const purchasesStep = pagedStep({
  key: "expenses",
  label: "Expenses, checks, and card charges",
  entity: "Purchase",
  preload: PRELOAD,
  async importOne(kit, r) {
    const kind = r.PaymentType === "Check" ? "Check" : r.PaymentType === "CreditCard" ? (r.Credit ? "Card credit" : "Card charge") : "Expense";
    const label = `${kind} ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "Purchase", r, label, async () => {
      const bankAccountId = await kit.local("Account", r.AccountRef as Ref);
      if (!bankAccountId) throw new AppError("invalid_input", `its account ${(r.AccountRef as Ref)?.name ?? ""} isn't here.`);
      const entity = r.EntityRef as EntityRef | undefined;
      const vendorId = entity?.type === "Vendor" ? await kit.local("Vendor", entity) : null;
      const customerId = entity?.type === "Customer" ? await kit.local("Customer", entity) : null;
      const credit = r.Credit === true;
      const fallback: PaymentMethod = r.PaymentType === "Check" ? "check" : r.PaymentType === "CreditCard" ? "credit_card" : "cash";
      const header = {
        type: credit ? ("deposit" as const) : r.PaymentType === "Check" ? ("check" as const) : ("expense" as const),
        txnDate: dateOf(r),
        bankAccountId,
        vendorId,
        customerId,
        payeeName: !vendorId && !customerId ? text(entity?.name, 200) : null,
        method: await methodOf(kit, r.PaymentMethodRef as Ref, fallback),
        reference: text(r.DocNumber, 100),
        memo: text(r.PrivateNote, 2000),
        ...(await currencyOf(kit, r)),
      };
      if (isVoided(r)) {
        const txn = await insertBankTxn(kit, r, header, [], "EXP", true);
        await kit.remember("Purchase", r.Id, txn.id);
        return;
      }
      const lines = await purchaseLines(kit, r, label, "in");
      checkTotal(kit, label, sumMoney(lines.map((l) => l.amount)), r.TotalAmt);
      if (credit && lines.some((l) => l.itemId)) kit.note(`${label}: items on a card credit came across without moving stock.`);
      const txn = await insertBankTxn(
        kit,
        r,
        header,
        lines.map((l) => ({
          accountId: l.accountId,
          amount: l.amount,
          description: l.description,
          customerId: l.customerId,
          dimensions: l.dimensions,
          itemId: credit ? null : l.itemId,
          quantity: credit ? null : l.quantity,
          unitCost: credit ? null : l.unitCost,
        })),
        credit ? "DEP" : "EXP"
      );
      await kit.remember("Purchase", r.Id, txn.id);
    });
  },
});

export const transfersStep = pagedStep({
  key: "transfers",
  label: "Transfers",
  entity: "Transfer",
  preload: ["Account"],
  async importOne(kit, r) {
    const label = `Transfer ${r.Id} (${String(r.TxnDate)})`;
    return importTxn(kit, "Transfer", r, label, async () => {
      const from = await kit.local("Account", r.FromAccountRef as Ref);
      const to = await kit.local("Account", r.ToAccountRef as Ref);
      if (!from || !to) throw new AppError("invalid_input", "one of its accounts isn't here.");
      const amount = amountOf(r.Amount);
      if (amount.lte(0)) throw new AppError("invalid_input", "its amount isn't more than zero.");
      const date = dateOf(r);
      await kit.year(date);
      const [txn] = await kit.ctx.tx
        .insert(bankTransactions)
        .values({
          organizationId: kit.org,
          txnNumber: await nextNumber(kit.ctx.tx, kit.org, "XFER"),
          type: "transfer",
          txnDate: date,
          bankAccountId: from,
          transferAccountId: to,
          memo: text(r.PrivateNote, 2000),
          ...(await currencyOf(kit, r)),
          totalAmount: toDbMoney(amount),
          status: "draft",
          ...creatorFields(kit.ctx.actor),
        })
        .returning();
      const { journalId } = await postBankTransactionToGl(kit.ctx, txn, []);
      await kit.ctx.tx.update(bankTransactions).set({ status: "posted", ...posted(kit, journalId) }).where(eq(bankTransactions.id, txn.id));
      await kit.remember("Transfer", r.Id, txn.id);
    });
  },
});
