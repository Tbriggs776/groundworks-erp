import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { checkingAccounts, listChecksToPrint } from "@/lib/ap/checks";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { AccountPicker } from "../account-picker";
import { PrintChecksClient } from "./print-client";

export default async function PrintChecksPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const sp = await searchParams;
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [accounts, queue] = await Promise.all([runAs(actor, (ctx) => checkingAccounts(ctx)), runAs(actor, (ctx) => listChecksToPrint(ctx))]);
  // Default to the first account with checks waiting.
  const account = accounts.find((a) => a.id === sp.account) ?? accounts.find((a) => queue.some((q) => q.bankAccountId === a.id)) ?? accounts[0];

  return (
    <AppShell title="Print Checks" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <div className="space-y-4 max-w-5xl">
        <p className="text-xs text-muted-foreground">
          Bill payments and checks marked “Print later” wait here. Load your voucher check stock, pick the checks, and confirm the first check
          number. Line up the printing under{" "}
          <Link href="/settings/company" className="text-primary hover:underline">Company settings</Link>.
        </p>
        {!account ? (
          <p className="text-sm text-muted-foreground">No bank accounts yet. Checks print from a bank account.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <AccountPicker accounts={accounts} value={account.id} />
              <span className="text-xs text-muted-foreground">
                {accounts
                  .map((a) => ({ a, n: queue.filter((q) => q.bankAccountId === a.id).length }))
                  .filter((x) => x.n > 0 && x.a.id !== account.id)
                  .map((x) => `${x.a.code} ${x.a.name}: ${x.n} waiting`)
                  .join(" · ")}
              </span>
            </div>
            <PrintChecksClient
              key={account.id}
              bankAccountId={account.id}
              nextCheckNumber={account.nextCheckNumber ?? 1001}
              checks={queue.filter((q) => q.bankAccountId === account.id)}
              canPrint={hasRole(role, "bookkeeper")}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
