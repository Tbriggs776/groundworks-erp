import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { closeChecklist, hasClosingPassword } from "@/lib/gl/close";
import { ClosePanel, TaskToggle } from "./close-panel";

const STATUS: Record<string, string> = { open: "Open", soft_closed: "Soft closed", hard_closed: "Hard closed" };

export default async function PeriodChecklistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const loaded = await runAs(actor, async (ctx) => ({ list: await closeChecklist(ctx, { id }), hasPassword: await hasClosingPassword(ctx) })).catch((err) => {
    if (toAppError(err).code === "not_found") return null;
    throw err;
  });
  if (!loaded) notFound();
  const { list, hasPassword } = loaded;
  const p = list.period;
  const isOpen = p.status === "open";
  const canClose = actor.kind === "user" && hasRole(actor.role, "admin") && !actor.support;
  const canSign = actor.kind === "user" && hasRole(actor.role, "bookkeeper") && !actor.support && isOpen;
  const day = (d: string) => format(parseISO(d), "MMM d, yyyy");

  return (
    <AppShell title={`Close ${p.periodCode}`} crumb={`${organization.name} · Close Books`} userEmail={user?.email}>
      <div className="space-y-6 max-w-4xl">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="text-sm">
            <span className="font-semibold">{day(p.startDate)} to {day(p.endDate)}</span>
            <span className="text-muted-foreground"> · {STATUS[p.status]}</span>
            {p.closedAt && (
              <span className="text-muted-foreground">
                {" "}since {new Date(p.closedAt).toLocaleDateString()}
                {p.closedByEmail ? ` by ${p.closedByEmail}` : ""}
              </span>
            )}
          </div>
          <Link href="/periods" className="text-xs text-primary hover:underline">← All periods</Link>
        </div>
        {p.closeNote && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-semibold">Closed with open items:</span> {p.closeNote}
          </p>
        )}

        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Checks as of {day(p.endDate)}</h2>
          <ul className="rounded-md border border-border divide-y divide-border">
            {list.checks.map((c) => (
              <li key={c.key} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  {c.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600" aria-label="Done" /> : <CircleAlert className="h-4 w-4 mt-0.5 text-amber-600" aria-label="Open" />}
                  <div className="space-y-1">
                    <div className="text-sm font-medium">{c.title}</div>
                    <div className="text-xs text-muted-foreground">{c.detail}</div>
                    {c.items.length > 0 && (
                      <ul className="text-xs space-y-0.5 pt-1">
                        {c.items.map((i) => (
                          <li key={i.label}>
                            {i.href ? <Link href={i.href} className="text-primary hover:underline">{i.label}</Link> : i.label}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Your checklist</h2>
            <Link href="/periods#checklist" className="text-xs text-primary hover:underline">Edit items</Link>
          </div>
          {list.tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No items yet. Add steps your team signs off each month on the Close Books page.</p>
          ) : (
            <ul className="rounded-md border border-border divide-y divide-border">
              {list.tasks.map((t) => (
                <li key={t.id} className="px-4 py-3 flex items-start gap-3">
                  <TaskToggle periodId={p.id} taskId={t.id} done={t.done} disabled={!canSign} title={t.title} />
                  <div className="space-y-0.5">
                    <div className="text-sm">{t.title}</div>
                    {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                    {t.done && (
                      <div className="text-xs text-muted-foreground">
                        Signed off {t.completedAt ? new Date(t.completedAt).toLocaleDateString() : ""}
                        {t.completedByEmail ? ` by ${t.completedByEmail}` : ""}
                        {t.note ? `: ${t.note}` : ""}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <ClosePanel
          periodId={p.id}
          periodCode={p.periodCode}
          status={p.status}
          openItems={list.openItems}
          alsoCloses={list.alsoCloses}
          canClose={canClose}
          hasPassword={hasPassword}
        />
      </div>
    </AppShell>
  );
}
