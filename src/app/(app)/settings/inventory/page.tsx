import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { getInventorySettings, METHOD_LABEL } from "@/lib/inventory/stock";
import { MethodForm } from "./method-form";

export default async function InventorySettingsPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const s = await runAs(actor, (ctx) => getInventorySettings(ctx));
  return (
    <AppShell title="Inventory Settings" crumb={`${organization.name} · Settings`} userEmail={user?.email}>
      <div className="max-w-2xl space-y-4">
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="font-semibold">Costing method</div>
          <p className="text-xs text-muted-foreground">
            How a sale of an inventory item is costed. FIFO takes the oldest units on hand first. Weighted average uses the running average
            cost of what&apos;s on hand. It&apos;s set once: after the first purchase, sale, or adjustment of an inventory item it can&apos;t
            change.
          </p>
          {s.locked ? (
            <p className="text-sm">
              {METHOD_LABEL[s.costingMethod]} <span className="text-xs text-muted-foreground">(locked: this company has inventory activity)</span>
            </p>
          ) : (
            <MethodForm method={s.costingMethod} canEdit={hasRole(role, "admin") && !actor.support} />
          )}
        </div>
      </div>
    </AppShell>
  );
}
