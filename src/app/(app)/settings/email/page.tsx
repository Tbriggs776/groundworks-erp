import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { getEmailSettings } from "@/lib/messaging/service";
import { PLACEHOLDERS, TEMPLATE_KEYS, TEMPLATE_LABELS } from "@/lib/messaging/templates";
import { EmailSettingsForm } from "./settings-form";

export default async function EmailSettingsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const s = await runAs(actor, (ctx) => getEmailSettings(ctx));
  return (
    <AppShell title="Email" crumb={`${organization.name} · Settings`} userEmail={user?.email}>
      <div className="max-w-3xl space-y-4">
        <div className="rounded-md border border-border px-4 py-3 text-xs space-y-1">
          <div>
            Email service: <span className={s.configured ? "text-emerald-700 font-semibold" : "text-destructive font-semibold"}>{s.configured ? "ready" : "not set up"}</span>
            {!s.configured && " (the app needs RESEND_API_KEY and EMAIL_FROM)"}
          </div>
          <div>
            Delivery tracking: <span className="font-semibold">{s.trackingConfigured ? "on" : "off"}</span>
            {!s.trackingConfigured && " (add RESEND_WEBHOOK_SECRET and point a Resend webhook at /api/webhooks/resend)"}
          </div>
          <div className="text-muted-foreground">Emails come from the app&apos;s sending address under {organization.name}&apos;s name, with the PDF attached.</div>
        </div>
        <EmailSettingsForm
          canEdit={hasRole(actor.role, "admin") && actor.kind === "user" && !actor.support}
          initial={{
            replyTo: s.replyTo ?? "",
            effectiveReplyTo: s.effectiveReplyTo,
            copyTo: s.copyTo ?? "",
            remindersEnabled: s.remindersEnabled,
            reminderDays: s.reminderDays,
            templates: s.templates,
            customized: s.customized,
          }}
          keys={TEMPLATE_KEYS.map((k) => ({ key: k, label: TEMPLATE_LABELS[k] }))}
          placeholders={[...PLACEHOLDERS]}
        />
      </div>
    </AppShell>
  );
}
