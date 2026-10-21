import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { plaidConfigured } from "@/lib/banking/feeds/plaid";
import { listBankFeeds } from "@/lib/banking/feeds/service";
import { listBankAccountsOverview } from "@/lib/banking/reconcile";
import { FeedsPanel } from "./feeds-panel";

/** Updating a feed reads every new transaction from the bank: give its action room. */
export const maxDuration = 60;

export default async function BankFeedsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [feeds, accounts] = await Promise.all([runAs(actor, (ctx) => listBankFeeds(ctx)), runAs(actor, (ctx) => listBankAccountsOverview(ctx))]);
  const canManage = hasRole(actor.role, "admin") && actor.kind === "user" && !actor.support;
  const canSync = hasRole(actor.role, "bookkeeper") && !actor.support;
  return (
    <AppShell title="Bank Feeds" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <FeedsPanel
        initial={feeds}
        accounts={accounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
        configured={plaidConfigured()}
        canManage={canManage}
        canSync={canSync}
      />
    </AppShell>
  );
}
