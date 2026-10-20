import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listUndepositedPayments } from "@/lib/banking/transactions";
import { bankingChoices } from "../../choices";
import { BankTxnForm, type TxnType } from "../bank-txn-form";

const TITLES: Record<TxnType, string> = {
  expense: "New Expense",
  check: "Write Check",
  deposit: "New Deposit",
  transfer: "New Transfer",
};

export default async function NewBankTransactionPage({ searchParams }: { searchParams: Promise<{ type?: string; account?: string }> }) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const type: TxnType = (["expense", "check", "deposit", "transfer"] as const).find((t) => t === sp.type) ?? "expense";
  const [choices, undeposited] = await Promise.all([
    runAs(actor, (ctx) => bankingChoices(ctx)),
    type === "deposit" ? runAs(actor, (ctx) => listUndepositedPayments(ctx)) : Promise.resolve([]),
  ]);

  return (
    <AppShell title={TITLES[type]} crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <BankTxnForm
        key={type}
        type={type}
        defaultAccountId={sp.account}
        choices={choices}
        undeposited={undeposited}
        currency={organization.baseCurrency}
      />
    </AppShell>
  );
}
