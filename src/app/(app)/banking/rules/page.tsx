import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listBankRules } from "@/lib/banking/rules";
import { bankingChoices } from "../choices";
import { RulesClient } from "./rules-client";

export default async function BankRulesPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [rules, choices] = await Promise.all([runAs(actor, (ctx) => listBankRules(ctx)), runAs(actor, (ctx) => bankingChoices(ctx))]);
  const canEdit = hasRole(role, "accountant");

  return (
    <AppShell title="Bank Rules" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <RulesClient rules={rules} choices={choices} canEdit={canEdit} />
    </AppShell>
  );
}
