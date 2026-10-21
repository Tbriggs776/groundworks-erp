import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { hasRole, runAs } from "@/lib/actor";
import { getEstimate } from "@/lib/ar/estimates";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { EmailButton } from "@/app/(app)/_email/email-button";
import { EmailHistory } from "@/app/(app)/_email/email-history";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { Notes, PdfLink } from "../../doc-view";
import { EstimateActions } from "./estimate-actions";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function EstimatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const canEmail = hasRole(actor.role, "bookkeeper") && !actor.support;
  const e = await runAs(actor, (ctx) => getEstimate(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  const creator = await creatorOf(e);
  const fmt = (v: string) => formatMoney(v, { currency: e.currency });
  const expired = e.status === "pending" && e.expirationDate && e.expirationDate < format(new Date(), "yyyy-MM-dd");
  const anyBilled = money(e.billedAmount).gt(0) || e.invoices.length > 0;

  return (
    <AppShell title={`Estimate ${e.estimateNumber}`} crumb={`${organization.name} · Sales · Estimates`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{e.estimateNumber}</div>
            <div className="text-sm mt-1">{e.customerName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>Dated {e.estimateDate}</span>
              {e.expirationDate && (
                <>
                  <span>·</span>
                  <span className={expired ? "text-destructive" : undefined}>
                    {expired ? "Expired" : "Expires"} {e.expirationDate}
                  </span>
                </>
              )}
              <StatusBadge status={e.status} />
              {e.acceptedDate && (
                <span>
                  Accepted {e.acceptedDate}
                  {e.acceptedBy ? ` by ${e.acceptedBy}` : ""}
                </span>
              )}
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <EstimateActions
              estimate={{
                id: e.id,
                estimateNumber: e.estimateNumber,
                status: e.status,
                currency: e.currency,
                invoiceCount: e.invoiceCount,
                acceptedDate: e.acceptedDate,
                remainingAmount: e.remainingAmount,
              }}
              lines={e.lines.map((l) => ({
                id: l.id,
                lineNumber: l.lineNumber,
                label: l.description ?? l.itemName ?? "Line",
                amount: l.amount,
                remaining: l.remaining,
              }))}
            />
            <div className="flex gap-2">
              {canEmail && true && <EmailButton documentType="estimate" documentId={e.id} />}
            </div>
            <PdfLink kind="estimate" id={e.id} />
            <Link href="/ar/estimates" className="text-xs text-muted-foreground hover:text-foreground">← Back to estimates</Link>
          </div>
        </div>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-10">#</th>
                <th className="text-left font-medium px-3 py-2">Product / service</th>
                <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
                <th className="text-right font-medium px-3 py-2 w-28">Rate</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                {anyBilled && <th className="text-right font-medium px-3 py-2 w-28">Billed</th>}
                {anyBilled && <th className="text-right font-medium px-3 py-2 w-28">Left</th>}
                <th className="text-center font-medium px-3 py-2 w-12">Tax</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
                  <td className="px-3 py-2">
                    {l.itemName && <div className="text-sm">{l.itemName}</div>}
                    {l.description && l.description !== l.itemName && <div className="text-xs text-muted-foreground">{l.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{money(l.quantity).toString()}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.unitPrice)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                  {anyBilled && <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.billed)}</td>}
                  {anyBilled && <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.remaining)}</td>}
                  <td className="px-3 py-2 text-center text-xs text-muted-foreground">{l.taxable ? "T" : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30">
              <Foot cols={anyBilled ? 7 : 5} label="Subtotal" value={fmt(e.subtotalAmount)} first />
              <Foot cols={anyBilled ? 7 : 5} label={`Sales tax${e.taxExempt ? " (exempt)" : ""}`} value={fmt(e.taxAmount)} />
              <Foot cols={anyBilled ? 7 : 5} label="Total" value={fmt(e.totalAmount)} strong />
              {anyBilled && <Foot cols={7} label="Billed before tax" value={fmt(e.billedAmount)} />}
              {anyBilled && <Foot cols={7} label="Left to bill before tax" value={fmt(e.remainingAmount)} strong />}
            </tfoot>
          </table>
        </div>

        {e.invoices.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Invoices from this estimate</div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {e.invoices.map((i) => (
                    <tr key={i.id} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/ar/invoices/${i.id}`} className="text-primary hover:underline">{i.invoiceNumber}</Link>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{i.invoiceDate}</td>
                      <td className="px-3 py-2"><StatusBadge status={i.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {fmt(i.subtotalAmount)} <span className="text-muted-foreground">before tax · {fmt(i.totalAmount)} total</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Notes memo={e.memo} privateNote={e.privateNote} />
        <EmailHistory actor={actor} documentType="estimate" documentId={e.id} />
        <AttachmentsSection entityType="estimate" entityId={id} />
      </div>
    </AppShell>
  );
}

function Foot({ cols, label, value, strong, first }: { cols: number; label: string; value: string; strong?: boolean; first?: boolean }) {
  return (
    <tr className={first ? "border-t-2 border-border" : undefined}>
      <td colSpan={cols - 1} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">{label}</td>
      <td className={`px-3 py-1 text-right font-mono ${strong ? "text-sm font-semibold" : "text-xs"}`}>{value}</td>
      <td></td>
    </tr>
  );
}
