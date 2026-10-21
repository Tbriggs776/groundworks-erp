import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  apBills,
  apCreditApplications,
  apPaymentApplications,
  apPayments,
  arCreditApplications,
  arInvoices,
  arPaymentApplications,
  arPayments,
  salesReceipts,
} from "@/lib/db/schema";
import { creatorFields } from "@/lib/actor";
import { billSettled } from "@/lib/ap/balances";
import { recomputeVendorCreditStatus } from "@/lib/ap/credits";
import { postPaymentToGl, recomputeBillPaymentStatus } from "@/lib/ap/payments";
import { invoiceSettled } from "@/lib/ar/balances";
import { recomputeCreditMemoStatus } from "@/lib/ar/credits";
import { postCustomerPaymentToGl, recomputeInvoiceStatus } from "@/lib/ar/posting";
import { undepositedFunds } from "@/lib/ar/sales-receipts";
import { AppError } from "@/lib/errors";
import { controlAccount } from "@/lib/gl/lookups";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import type { QboRecord } from "../client";
import { pagedStep, type Kit, type Ref } from "./kit";
import { insertBankTxn } from "./purchases";
import { amountOf, auditVoided, currencyOf, dateOf, importTxn, isVoided, methodOf, tags, text, voidedAt } from "./txn";

/**
 * Money that settles documents: customer payments (and the credit memos
 * QuickBooks applied in them), bill payments (and vendor credits), and the
 * deposits that move payments out of Undeposited Funds. QuickBooks says
 * exactly what each payment paid; that's what's applied here.
 */

const VOID_REASON = "Voided in QuickBooks";
type Link = { type: string; qboId: string; amount: Decimal };

/** Each line's linked transaction and the amount on it. */
function links(r: QboRecord): Link[] {
  const out: Link[] = [];
  for (const l of (r.Line as Array<{ Amount?: number; LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }> | undefined) ?? []) {
    const t = l.LinkedTxn?.[0];
    if (t?.TxnId && t.TxnType) out.push({ type: t.TxnType, qboId: t.TxnId, amount: amountOf(l.Amount) });
  }
  return out;
}

const min = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);

/**
 * Split what a payment settles into credits used first, then cash, never
 * more than each document has open. QuickBooks puts a credit memo used in a
 * payment on its own line; the documents' lines add up to cash + credits.
 */
function allocate(
  docs: Array<{ id: string; amount: Decimal; open: Decimal }>,
  credits: Array<{ id: string; amount: Decimal }>
): { cash: Array<{ id: string; amount: Decimal }>; credit: Array<{ creditId: string; docId: string; amount: Decimal }>; capped: boolean; creditLeft: Decimal } {
  const pool = credits.map((c) => ({ ...c, left: c.amount }));
  const cash: Array<{ id: string; amount: Decimal }> = [];
  const credit: Array<{ creditId: string; docId: string; amount: Decimal }> = [];
  let capped = false;
  for (const d of docs) {
    let want = min(d.amount, d.open);
    if (want.lt(d.amount)) capped = true;
    for (const c of pool) {
      if (want.lte(0)) break;
      const take = min(want, c.left);
      if (take.lte(0)) continue;
      credit.push({ creditId: c.id, docId: d.id, amount: take });
      c.left = c.left.minus(take);
      want = want.minus(take);
    }
    if (want.gt(0)) cash.push({ id: d.id, amount: want });
  }
  return { cash, credit, capped, creditLeft: sumMoney(pool.map((c) => c.left)) };
}

// ---------------------------------------------------------------------------
// Customer payments
// ---------------------------------------------------------------------------

async function invoiceOpen(kit: Kit, invoiceId: string): Promise<Decimal> {
  const [inv] = await kit.ctx.tx.select({ total: arInvoices.totalAmount, status: arInvoices.status }).from(arInvoices).where(eq(arInvoices.id, invoiceId));
  if (!inv || (inv.status !== "open" && inv.status !== "paid")) return money(0);
  return money(inv.total).minus(await invoiceSettled(kit.ctx.tx, invoiceId));
}

export const customerPaymentsStep = pagedStep({
  key: "payments",
  label: "Customer payments",
  entity: "Payment",
  preload: ["Customer", "Account", "Invoice", "CreditMemo", "PaymentMethod"],
  async importOne(kit, r) {
    const label = `Payment ${String(r.PaymentRefNum ?? r.Id)} (${String(r.TxnDate)})`;
    return importTxn(kit, "Payment", r, label, async () => {
      const customerId = await kit.local("Customer", r.CustomerRef as Ref);
      if (!customerId) throw new AppError("invalid_input", `its customer ${(r.CustomerRef as Ref)?.name ?? ""} isn't here.`);
      const date = dateOf(r);
      const header = {
        organizationId: kit.org,
        customerId,
        paymentDate: date,
        method: await methodOf(kit, r.PaymentMethodRef as Ref, "check"),
        reference: text(r.PaymentRefNum, 100),
        depositAccountId: (await kit.local("Account", r.DepositToAccountRef as Ref)) ?? (await undepositedFunds(kit.ctx)),
        ...(await currencyOf(kit, r)),
        memo: text(r.PrivateNote, 2000),
        ...creatorFields(kit.ctx.actor),
      };
      if (isVoided(r)) {
        const paymentNumber = await nextNumber(kit.ctx.tx, kit.org, "ARPAY");
        const [p] = await kit.ctx.tx
          .insert(arPayments)
          .values({ ...header, paymentNumber, status: "voided", voidedAt: voidedAt(r), voidedBy: kit.ctx.actor.userId, voidReason: VOID_REASON })
          .returning();
        await auditVoided(kit, "ar_payment", p.id, paymentNumber);
        await kit.remember("Payment", r.Id, p.id);
        return;
      }

      const docs: Array<{ id: string; amount: Decimal; open: Decimal }> = [];
      const credits: Array<{ id: string; amount: Decimal }> = [];
      for (const l of links(r)) {
        const local = await kit.local(l.type, { value: l.qboId });
        if (l.type === "Invoice" && local) docs.push({ id: local, amount: l.amount, open: await invoiceOpen(kit, local) });
        else if (l.type === "CreditMemo" && local) credits.push({ id: local, amount: l.amount });
        else kit.note(`${label}: its ${l.type} ${l.qboId} line (${l.amount.toFixed(2)}) isn't here, so that part stays unapplied.`);
      }
      const plan = allocate(docs, credits);
      if (plan.capped) kit.note(`${label} paid more on an invoice than was open here; the rest stays as the customer's credit.`);
      if (plan.creditLeft.gt(0)) kit.note(`${label}: ${plan.creditLeft.toFixed(2)} of credit memos it used had no invoice left to pay here.`);

      const total = amountOf(r.TotalAmt);
      let cashApplied = sumMoney(plan.cash.map((c) => c.amount));
      while (cashApplied.gt(total) && plan.cash.length) {
        // QuickBooks' lines claim more cash than came in: trim from the last.
        const last = plan.cash[plan.cash.length - 1];
        const cut = min(last.amount, cashApplied.minus(total));
        last.amount = last.amount.minus(cut);
        if (last.amount.lte(0)) plan.cash.pop();
        cashApplied = cashApplied.minus(cut);
      }

      let paymentId: string | null = null;
      if (total.gt(0)) {
        await kit.year(date);
        const [p] = await kit.ctx.tx
          .insert(arPayments)
          .values({ ...header, paymentNumber: await nextNumber(kit.ctx.tx, kit.org, "ARPAY"), amount: toDbMoney(total), status: "draft" })
          .returning();
        if (plan.cash.length) {
          await kit.ctx.tx
            .insert(arPaymentApplications)
            .values(plan.cash.map((c) => ({ organizationId: kit.org, paymentId: p.id, invoiceId: c.id, amount: toDbMoney(c.amount) })));
        }
        const { journalId } = await postCustomerPaymentToGl(kit.ctx, p);
        await kit.ctx.tx
          .update(arPayments)
          .set({ status: "posted", postedAt: sql`now()`, postedBy: kit.ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` })
          .where(eq(arPayments.id, p.id));
        paymentId = p.id;
      }
      if (plan.credit.length) {
        await kit.ctx.tx.insert(arCreditApplications).values(
          plan.credit.map((c) => ({
            organizationId: kit.org,
            customerId,
            creditMemoId: c.creditId,
            invoiceId: c.docId,
            amount: toDbMoney(c.amount),
            appliedOn: date,
            ...creatorFields(kit.ctx.actor),
          }))
        );
        for (const id of new Set(plan.credit.map((c) => c.creditId))) await recomputeCreditMemoStatus(kit.ctx.tx, kit.org, id);
      }
      for (const d of docs) await recomputeInvoiceStatus(kit.ctx.tx, kit.org, d.id);
      await kit.remember("Payment", r.Id, paymentId, paymentId ? null : "credits only");
    });
  },
});

// ---------------------------------------------------------------------------
// Bill payments
// ---------------------------------------------------------------------------

async function billOpen(kit: Kit, billId: string): Promise<Decimal> {
  const [b] = await kit.ctx.tx.select({ total: apBills.totalAmount, status: apBills.status }).from(apBills).where(eq(apBills.id, billId));
  if (!b || (b.status !== "posted" && b.status !== "paid")) return money(0);
  return money(b.total).minus(await billSettled(kit.ctx.tx, billId));
}

export const billPaymentsStep = pagedStep({
  key: "bill_payments",
  label: "Bill payments",
  entity: "BillPayment",
  preload: ["Vendor", "Account", "Bill", "VendorCredit"],
  async importOne(kit, r) {
    const label = `Bill payment ${String(r.DocNumber ?? r.Id)} (${String(r.TxnDate)})`;
    return importTxn(kit, "BillPayment", r, label, async () => {
      const vendorId = await kit.local("Vendor", r.VendorRef as Ref);
      if (!vendorId) throw new AppError("invalid_input", `its vendor ${(r.VendorRef as Ref)?.name ?? ""} isn't here.`);
      const card = r.PayType === "CreditCard";
      const accountRef = card
        ? (r.CreditCardPayment as { CCAccountRef?: Ref } | undefined)?.CCAccountRef
        : (r.CheckPayment as { BankAccountRef?: Ref } | undefined)?.BankAccountRef;
      const bankAccountId = await kit.local("Account", accountRef);
      if (!bankAccountId) throw new AppError("invalid_input", "the account it was paid from isn't here.");
      const date = dateOf(r);
      const header = {
        organizationId: kit.org,
        vendorId,
        paymentDate: date,
        method: card ? ("credit_card" as const) : ("check" as const),
        reference: text(r.DocNumber, 100),
        bankAccountId,
        ...(await currencyOf(kit, r)),
        memo: text(r.PrivateNote, 2000),
        ...creatorFields(kit.ctx.actor),
      };
      if (isVoided(r)) {
        const paymentNumber = await nextNumber(kit.ctx.tx, kit.org, "APPAY");
        const [p] = await kit.ctx.tx
          .insert(apPayments)
          .values({ ...header, paymentNumber, status: "voided", voidedAt: voidedAt(r), voidedBy: kit.ctx.actor.userId, voidReason: VOID_REASON })
          .returning();
        await auditVoided(kit, "ap_payment", p.id, paymentNumber);
        await kit.remember("BillPayment", r.Id, p.id);
        return;
      }

      const docs: Array<{ id: string; amount: Decimal; open: Decimal }> = [];
      const credits: Array<{ id: string; amount: Decimal }> = [];
      for (const l of links(r)) {
        const local = await kit.local(l.type, { value: l.qboId });
        if (l.type === "Bill" && local) docs.push({ id: local, amount: l.amount, open: await billOpen(kit, local) });
        else if (l.type === "VendorCredit" && local) credits.push({ id: local, amount: l.amount });
        else kit.note(`${label}: its ${l.type} ${l.qboId} line (${l.amount.toFixed(2)}) isn't here.`);
      }
      const plan = allocate(docs, credits);
      if (plan.capped) kit.note(`${label} paid more on a bill than was open here.`);
      const total = amountOf(r.TotalAmt);
      const applied = min(sumMoney(plan.cash.map((c) => c.amount)), total);
      await kit.year(date);

      let paymentId: string | null = null;
      if (applied.gt(0)) {
        let left = applied;
        const apps = plan.cash.flatMap((c) => {
          const amt = min(c.amount, left);
          left = left.minus(amt);
          return amt.gt(0) ? [{ billId: c.id, amount: amt }] : [];
        });
        const [p] = await kit.ctx.tx
          .insert(apPayments)
          .values({
            ...header,
            paymentNumber: await nextNumber(kit.ctx.tx, kit.org, "APPAY"),
            appliedAmount: toDbMoney(applied),
            netAmount: toDbMoney(applied),
            status: "draft",
          })
          .returning();
        await kit.ctx.tx
          .insert(apPaymentApplications)
          .values(apps.map((a) => ({ organizationId: kit.org, paymentId: p.id, billId: a.billId, appliedAmount: toDbMoney(a.amount) })));
        const { journalId } = await postPaymentToGl(kit.ctx, p);
        await kit.ctx.tx
          .update(apPayments)
          .set({ status: "posted", postedAt: sql`now()`, postedBy: kit.ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` })
          .where(eq(apPayments.id, p.id));
        paymentId = p.id;
      }
      // Paid with nothing to apply it to (a prepayment): it still left the bank, against Accounts Payable.
      const unapplied = total.minus(applied);
      let extra: string | null = null;
      if (unapplied.gt(0)) {
        const ap = await controlAccount(kit.ctx.tx, kit.org, "payables");
        const txn = await insertBankTxn(
          kit,
          r,
          {
            type: card ? "expense" : "check",
            txnDate: date,
            bankAccountId,
            vendorId,
            method: header.method,
            reference: header.reference,
            memo: "Unapplied part of a QuickBooks bill payment",
            currency: header.currency,
            exchangeRate: header.exchangeRate,
          },
          [{ accountId: ap.id, amount: toDbMoney(unapplied), description: "Vendor prepayment from QuickBooks" }],
          "EXP"
        );
        extra = txn.id;
        kit.note(`${label}: ${unapplied.toFixed(2)} wasn't applied to a bill in QuickBooks; here it's a ${card ? "card charge" : "check"} against Accounts Payable.`);
      }
      if (plan.credit.length) {
        await kit.ctx.tx.insert(apCreditApplications).values(
          plan.credit.map((c) => ({
            organizationId: kit.org,
            vendorId,
            vendorCreditId: c.creditId,
            billId: c.docId,
            amount: toDbMoney(c.amount),
            appliedOn: date,
            ...creatorFields(kit.ctx.actor),
          }))
        );
        for (const id of new Set(plan.credit.map((c) => c.creditId))) await recomputeVendorCreditStatus(kit.ctx.tx, kit.org, id);
      }
      for (const d of docs) await recomputeBillPaymentStatus(kit.ctx.tx, kit.org, d.id);
      await kit.remember("BillPayment", r.Id, paymentId, extra);
    });
  },
});

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

type DepositLine = {
  Amount?: number;
  Description?: string;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
  DepositLineDetail?: { AccountRef?: Ref; Entity?: { value?: string; name?: string; type?: string }; ClassRef?: Ref; CheckNum?: string };
};

export const depositsStep = pagedStep({
  key: "deposits",
  label: "Deposits",
  entity: "Deposit",
  preload: ["Customer", "Account", "Payment", "SalesReceipt", "Class", "Department"],
  async importOne(kit, r) {
    const label = `Deposit ${r.Id} (${String(r.TxnDate)})`;
    return importTxn(kit, "Deposit", r, label, async () => {
      const bankAccountId = await kit.local("Account", r.DepositToAccountRef as Ref);
      if (!bankAccountId) throw new AppError("invalid_input", "the account it went into isn't here.");
      const uf = await undepositedFunds(kit.ctx);
      const dept = r.DepartmentRef as Ref;
      const lines: Parameters<typeof insertBankTxn>[3] = [];
      for (const l of (r.Line as DepositLine[] | undefined) ?? []) {
        const amount = amountOf(l.Amount);
        if (amount.isZero()) continue;
        const t = l.LinkedTxn?.[0];
        if (t?.TxnId && t.TxnType) {
          // Money moved out of Undeposited Funds: the payment or sales receipt it was.
          const local = t.TxnType === "Payment" || t.TxnType === "SalesReceipt" ? await kit.local(t.TxnType, { value: t.TxnId }) : null;
          const held = local ? await heldIn(kit, t.TxnType, local) : null;
          if (local && held) {
            lines.push({
              accountId: held.accountId,
              amount: toDbMoney(amount),
              description: held.label,
              customerId: held.customerId,
              arPaymentId: t.TxnType === "Payment" ? local : null,
              salesReceiptId: t.TxnType === "SalesReceipt" ? local : null,
            });
          } else {
            lines.push({ accountId: uf, amount: toDbMoney(amount), description: `QuickBooks ${t.TxnType} ${t.TxnId}` });
            kit.note(`${label}: its ${t.TxnType} ${t.TxnId} (${amount.toFixed(2)}) isn't here, so that line comes out of Undeposited Funds on its own.`);
          }
          continue;
        }
        const d = l.DepositLineDetail;
        const accountId = await kit.local("Account", d?.AccountRef);
        if (!accountId) throw new AppError("invalid_input", `account ${d?.AccountRef?.name ?? ""} isn't in the chart.`);
        lines.push({
          accountId,
          amount: toDbMoney(amount),
          description: text(l.Description, 1000) ?? (d?.CheckNum ? `Check ${d.CheckNum}` : null),
          customerId: d?.Entity?.type === "Customer" ? await kit.local("Customer", d.Entity) : null,
          dimensions: await tags(kit, d?.ClassRef, dept),
        });
      }
      const back = r.CashBack as { AccountRef?: Ref; Amount?: number; Memo?: string } | undefined;
      if (back && amountOf(back.Amount).gt(0)) {
        const accountId = await kit.local("Account", back.AccountRef);
        if (!accountId) throw new AppError("invalid_input", "its cash back account isn't in the chart.");
        lines.push({ accountId, amount: toDbMoney(amountOf(back.Amount).neg()), description: text(back.Memo, 500) ?? "Cash back" });
      }
      if (lines.length === 0) throw new AppError("invalid_input", "it has no lines with an amount.");
      const txn = await insertBankTxn(
        kit,
        r,
        { type: "deposit", txnDate: dateOf(r), bankAccountId, memo: text(r.PrivateNote, 2000), ...(await currencyOf(kit, r)) },
        lines,
        "DEP"
      );
      await kit.remember("Deposit", r.Id, txn.id);
    });
  },
});

/** Where a payment or sales receipt sat before the deposit (Undeposited Funds, usually). */
async function heldIn(kit: Kit, type: string, id: string): Promise<{ accountId: string; customerId: string | null; label: string } | null> {
  if (type === "Payment") {
    const [p] = await kit.ctx.tx.select().from(arPayments).where(and(eq(arPayments.id, id), inArray(arPayments.status, ["posted"])));
    return p ? { accountId: p.depositAccountId, customerId: p.customerId, label: `Payment ${p.paymentNumber}${p.reference ? ` · ${p.reference}` : ""}` } : null;
  }
  const [s] = await kit.ctx.tx.select().from(salesReceipts).where(and(eq(salesReceipts.id, id), eq(salesReceipts.status, "posted")));
  return s ? { accountId: s.depositAccountId, customerId: s.customerId, label: `Sales receipt ${s.receiptNumber}${s.reference ? ` · ${s.reference}` : ""}` } : null;
}
