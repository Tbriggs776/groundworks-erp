import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { getReconciliation, getReconciliationReport, type WorksheetLine } from "@/lib/banking/reconcile";
import { toAppError } from "@/lib/errors";
import { formatMoney, sumMoney } from "@/lib/money";
import { Stat } from "../../ui";
import { UndoReconciliation, Worksheet } from "./worksheet";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function ReconciliationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const sheet = await runAs(actor, (ctx) => getReconciliation(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const currency = organization.baseCurrency;
  const title = `Reconcile ${sheet.accountCode} · ${sheet.accountName}`;

  if (sheet.status === "in_progress") {
    return (
      <AppShell title={title} crumb={`${organization.name} · Banking · Reconcile`} userEmail={user?.email}>
        <Worksheet sheet={sheet} currency={currency} canEdit={hasRole(role, "accountant")} />
      </AppShell>
    );
  }

  const report = await runAs(actor, (ctx) => getReconciliationReport(ctx, { id }));
  const fmt = (v: string) => formatMoney(v, { currency });

  return (
    <AppShell title={title} crumb={`${organization.name} · Banking · Reconcile`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl tracking-[0.06em]">Statement ending {sheet.statementEndDate}</div>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
              <Badge variant={sheet.status === "completed" ? "default" : "outline"} className="text-[9px] capitalize">{sheet.status}</Badge>
              {sheet.completedAt && <span>Finished {new Date(sheet.completedAt).toLocaleString()}</span>}
              {sheet.status === "undone" && sheet.undoReason && <span>Undone: {sheet.undoReason}</span>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {sheet.status === "completed" && hasRole(role, "admin") && <UndoReconciliation id={sheet.id} />}
            <Link href="/banking/reconcile" className="text-xs text-muted-foreground hover:text-foreground">← All reconciliations</Link>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Beginning balance" value={fmt(sheet.beginningBalance)} />
          <Stat label="Statement ending balance" value={fmt(sheet.statementEndingBalance)} />
          <Stat label="Cleared balance" value={fmt(sheet.clearedBalance)} />
          <Stat label="Items reconciled" value={String(sheet.clearedCount)} />
        </div>
        <ReportTable title="Reconciled" lines={report.reconciled} currency={currency} />
        <ReportTable title={`Still uncleared as of ${sheet.statementEndDate}`} lines={report.uncleared} currency={currency} />
        <AttachmentsSection entityType="reconciliation" entityId={id} />
      </div>
    </AppShell>
  );
}

function ReportTable({ title, lines, currency }: { title: string; lines: WorksheetLine[]; currency: string }) {
  const fmt = (v: string) => formatMoney(v, { currency });
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-2">
        {title} · {lines.length} item{lines.length === 1 ? "" : "s"} · {fmt(sumMoney(lines.map((l) => l.amount)).toFixed(4))}
      </div>
      {lines.length > 0 && (
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {lines.map((l) => (
                <tr key={l.glLineId} className="border-t border-border first:border-t-0">
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground w-28">{l.date}</td>
                  <td className="px-3 py-2 text-xs font-mono w-32">
                    <Link href={`/gl/${l.journalId}`} className="text-primary hover:underline">{l.journalNumber}</Link>
                  </td>
                  <td className="px-3 py-2">{l.description}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs w-32">{fmt(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
