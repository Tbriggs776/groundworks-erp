import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { getImportView } from "@/lib/qbo/service";
import { getTieout } from "@/lib/qbo/tieout";
import { ImportPanel } from "./import-panel";
import { TieoutPanel } from "./tieout-panel";

/** An import batch runs for up to 20 seconds, then recosts inventory: give its action room. */
export const maxDuration = 60;

export default async function QuickBooksPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const view = await runAs(actor, (ctx) => getImportView(ctx));
  const tieout = view?.status === "done" ? await runAs(actor, (ctx) => getTieout(ctx)) : null;
  const canRun = hasRole(actor.role, "admin") && actor.kind === "user" && !actor.support;
  return (
    <AppShell title="QuickBooks Import" crumb={`${organization.name} · Settings`} userEmail={user?.email}>
      <div className="max-w-3xl space-y-4">
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">{error}</div>}
        {view ? (
          <>
            <ImportPanel initial={view} canRun={canRun} />
            {tieout && <TieoutPanel initial={tieout} canRun={canRun} connected={Boolean(view.connection?.connected)} />}
          </>
        ) : (
          <div className="rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
            <div className="font-semibold">This company wasn&apos;t imported from QuickBooks</div>
            <p className="text-muted-foreground">
              To bring a company over from QuickBooks Online, use{" "}
              <Link href="/workspace" className="text-primary hover:underline">
                Import from QuickBooks
              </Link>{" "}
              on the workspace page. It makes a new company with the chart of accounts, customers, vendors, products, and history.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
