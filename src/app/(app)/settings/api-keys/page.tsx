import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs, scopesForRole } from "@/lib/actor";
import { listMyApiKeys, listPersonalKeys } from "@/lib/agents/service";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { appOrigin } from "@/lib/ui/origin";
import { ApiKeysClient } from "./api-keys-client";

export default async function ApiKeysPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const isAdmin = hasRole(role, "admin");
  const [mine, everyone, origin] = await Promise.all([
    runAs(actor, (ctx) => listMyApiKeys(ctx)),
    isAdmin ? runAs(actor, (ctx) => listPersonalKeys(ctx)) : Promise.resolve([]),
    appOrigin(),
  ]);

  return (
    <AppShell title="API Keys" crumb={`${organization.name} · Agents & API`} userEmail={user?.email}>
      <ApiKeysClient
        mine={mine}
        everyone={everyone.filter((k) => k.userEmail !== user?.email)}
        allowedScopes={scopesForRole(role)}
        origin={origin}
      />
    </AppShell>
  );
}
