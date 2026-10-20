import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { salesFormData } from "@/lib/ui/form-data";
import { cn } from "@/lib/utils";
import { SalesDocForm } from "../../sales-doc-form";
import { CreditRefundForm } from "../credit-refund-form";

export default async function NewRefundPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; customerId?: string; creditMemoId?: string; paymentId?: string }>;
}) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  await requireActor("bookkeeper");
  const data = await salesFormData(organization.id);
  const kind = sp.kind === "credit" ? "credit" : "items";
  const tab = (k: string, label: string) => (
    <Link
      href={`/ar/refunds/new?kind=${k}${sp.customerId ? `&customerId=${sp.customerId}` : ""}`}
      className={cn(
        "px-3 py-2 text-xs font-medium border-b-2 -mb-px",
        kind === k ? "border-[var(--gw-gold)] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );

  return (
    <AppShell title="New Refund" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-5">
        <div className="flex gap-1 border-b border-border max-w-5xl">
          {tab("items", "Refund returned items")}
          {tab("credit", "Pay out a credit")}
        </div>
        {kind === "items" ? (
          <SalesDocForm
            kind="refund"
            customers={data.customers}
            items={data.items}
            incomeAccounts={data.incomeAccounts}
            taxRates={data.taxRates}
            bankAccounts={data.bankAccounts}
            defaultCustomerId={sp.customerId}
          />
        ) : (
          <CreditRefundForm
            customers={data.customers.map((c) => ({ id: c.id, name: c.name, currency: c.currency }))}
            bankAccounts={data.bankAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
            defaultCustomerId={sp.customerId}
            defaultCreditId={sp.creditMemoId ?? sp.paymentId}
          />
        )}
      </div>
    </AppShell>
  );
}
