import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listBankAccountsOverview } from "@/lib/banking/reconcile";
import { listStatementLines } from "@/lib/banking/review";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { AccountPicker } from "../account-picker";
import { bankingChoices } from "../choices";
import { ImportStatement } from "./import-statement";
import { ApplyRulesButton, ReviewLines } from "./review-lines";

const TABS = [
  { status: "for_review", label: "For review" },
  { status: "matched", label: "Matched" },
  { status: "added", label: "Added" },
  { status: "excluded", label: "Excluded" },
] as const;
type Tab = (typeof TABS)[number]["status"];

export default async function ForReviewPage({ searchParams }: { searchParams: Promise<{ account?: string; status?: string }> }) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const accounts = await runAs(actor, (ctx) => listBankAccountsOverview(ctx));
  const account = accounts.find((a) => a.id === sp.account) ?? accounts.find((a) => a.forReview > 0) ?? accounts[0];
  const status: Tab = TABS.some((t) => t.status === sp.status) ? (sp.status as Tab) : "for_review";

  if (!account) {
    return (
      <AppShell title="For Review" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
        <p className="text-sm text-muted-foreground">
          No reconcilable bank or card accounts yet. Mark one for reconciliation in the{" "}
          <Link href="/accounts" className="text-primary hover:underline">chart of accounts</Link>.
        </p>
      </AppShell>
    );
  }

  const [page, choices] = await Promise.all([
    runAs(actor, (ctx) => listStatementLines(ctx, { accountId: account.id, status, limit: 200 })),
    runAs(actor, (ctx) => bankingChoices(ctx)),
  ]);
  const fmt = (v: string) => formatMoney(v, { currency: organization.baseCurrency });

  return (
    <AppShell title="For Review" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <AccountPicker accounts={accounts} value={account.id} />
            <div className="text-xs text-muted-foreground">
              Books {fmt(account.bookBalance)}
              {account.lastImport?.ledgerBalance && <> · Bank {fmt(account.lastImport.ledgerBalance)}</>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ApplyRulesButton accountId={account.id} />
            <ImportStatement accountId={account.id} accountName={`${account.code} · ${account.name}`} />
          </div>
        </div>

        <div className="flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <Link
              key={t.status}
              href={`/banking/review?account=${account.id}&status=${t.status}`}
              className={cn(
                "px-3 py-2 text-xs font-medium border-b-2 -mb-px",
                t.status === status ? "border-[var(--gw-gold)] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
              {t.status === "for_review" && account.forReview > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px]">{account.forReview}</span>
              )}
            </Link>
          ))}
        </div>

        <ReviewLines
          key={`${account.id}-${status}`}
          lines={page.data}
          status={status}
          accountId={account.id}
          currency={organization.baseCurrency}
          choices={choices}
        />
        {page.hasMore && <p className="text-xs text-muted-foreground">Showing the first 200. Work through these and the rest will follow.</p>}
      </div>
    </AppShell>
  );
}
