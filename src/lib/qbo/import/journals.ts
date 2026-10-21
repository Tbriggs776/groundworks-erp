import { and, eq } from "drizzle-orm";
import { dimensions, organizations } from "@/lib/db/schema";
import { ensureFiscalYearFor } from "@/lib/gl/fiscal-calendar";
import { sourceCodeId } from "@/lib/gl/lookups";
import { createAndPostJournal, type JournalLineInput, type PostResult } from "@/lib/gl/posting";
import { toAppError } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import type { QboRecord } from "../client";
import { pagedStep, type Kit, type Ref } from "./kit";

/**
 * Journal entries, with QuickBooks' amounts exactly. They post as
 * `conversion` journals (allowed on AR and AP, as QuickBooks is), on their
 * own dates, keeping the customer or vendor, class, and department of each
 * line. Fiscal years are made as the history needs them.
 */

type JeLine = {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: "Debit" | "Credit";
    AccountRef?: Ref;
    Entity?: { Type?: string; EntityRef?: Ref };
    ClassRef?: Ref;
    DepartmentRef?: Ref;
  };
};

/** Fiscal year start month, and Class / Location dimension ids, for the batch. */
export async function setup(kit: Kit) {
  const [org] = await kit.ctx.tx.select({ startMonth: organizations.fiscalYearStartMonth }).from(organizations).where(eq(organizations.id, kit.org));
  const dims = await kit.ctx.tx
    .select({ id: dimensions.id, code: dimensions.code })
    .from(dimensions)
    .where(and(eq(dimensions.organizationId, kit.org)));
  return {
    startMonth: org.startMonth,
    classDim: dims.find((d) => d.code === "CLASS")?.id,
    locationDim: dims.find((d) => d.code === "LOCATION")?.id,
  };
}

/** Class and department on a line, as dimension tags. */
export async function lineTags(kit: Kit, s: { classDim?: string; locationDim?: string }, classRef: Ref, deptRef: Ref) {
  const tags: Array<{ dimensionId: string; valueId: string }> = [];
  const cls = await kit.local("Class", classRef);
  const dept = await kit.local("Department", deptRef);
  if (cls && s.classDim) tags.push({ dimensionId: s.classDim, valueId: cls });
  if (dept && s.locationDim) tags.push({ dimensionId: s.locationDim, valueId: dept });
  return tags.length ? tags : undefined;
}

export const journalEntriesStep = pagedStep({
  key: "journal_entries",
  label: "Journal entries",
  entity: "JournalEntry",
  preload: ["Account", "Customer", "Vendor", "Class", "Department"],
  async importOne(kit, r: QboRecord) {
    const s = await kit.once("journal-setup", () => setup(kit));
    const label = `Journal entry ${r.DocNumber ? String(r.DocNumber) : r.Id} (${String(r.TxnDate)})`;
    const lines: JournalLineInput[] = [];
    for (const l of (r.Line as JeLine[] | undefined) ?? []) {
      const d = l.JournalEntryLineDetail;
      if (l.DetailType !== "JournalEntryLineDetail" || !d || !l.Amount) continue;
      const accountId = await kit.local("Account", d.AccountRef);
      if (!accountId) {
        kit.note(`${label} didn't come across: account ${d.AccountRef?.name ?? d.AccountRef?.value} isn't in the chart.`);
        await kit.remember("JournalEntry", r.Id, null, "skipped");
        return "skipped";
      }
      const amt = toDbMoney(money(l.Amount));
      const entity = d.Entity?.Type;
      lines.push({
        accountId,
        ...(d.PostingType === "Credit" ? { credit: amt } : { debit: amt }),
        memo: l.Description?.slice(0, 500),
        customerId: entity === "Customer" ? ((await kit.local("Customer", d.Entity?.EntityRef)) ?? undefined) : undefined,
        vendorId: entity === "Vendor" ? ((await kit.local("Vendor", d.Entity?.EntityRef)) ?? undefined) : undefined,
        dimensions: await lineTags(kit, s, d.ClassRef, d.DepartmentRef),
      });
    }
    if (lines.length === 0) {
      await kit.remember("JournalEntry", r.Id, null, "empty");
      return "skipped";
    }
    const date = String(r.TxnDate);
    await ensureFiscalYearFor(kit.ctx.tx, kit.org, s.startMonth, date);
    const result: PostResult = await createAndPostJournal(
      {
        organizationId: kit.org,
        actorId: kit.ctx.actor.userId,
        actor: kit.ctx.actor,
        journalDate: date,
        sourceCodeId: await sourceCodeId(kit.ctx.tx, kit.org, r.Adjustment ? "ADJ" : "GJ"),
        source: "conversion",
        description: (typeof r.PrivateNote === "string" && r.PrivateNote.trim() ? r.PrivateNote.trim() : `QuickBooks ${label}`).slice(0, 500),
        documentNo: r.DocNumber ? String(r.DocNumber).slice(0, 50) : undefined,
        currency: (r.CurrencyRef as Ref)?.value,
        exchangeRate: typeof r.ExchangeRate === "number" ? String(r.ExchangeRate) : undefined,
        lines,
      },
      kit.ctx.tx
    ).catch((err) => ({ ok: false, error: toAppError(err).message, code: "error" }));
    if (!result.ok) {
      kit.note(`${label} didn't post: ${result.error}`);
      await kit.remember("JournalEntry", r.Id, null, "failed");
      return "skipped";
    }
    await kit.remember("JournalEntry", r.Id, result.journalId);
    return "imported";
  },
});
