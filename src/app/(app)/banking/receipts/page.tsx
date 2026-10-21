import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { readerConfigured } from "@/lib/attachments/reader";
import { getAttachment, listAttachments, type AttachmentDetail } from "@/lib/attachments/service";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { storageConfigured } from "@/lib/files/storage";
import { bankingChoices } from "../choices";
import { ReceiptsPanel } from "./receipts-panel";

/** Reading a receipt takes a few seconds; uploads run it after the response. */
export const maxDuration = 60;

export default async function ReceiptsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [receipts, choices] = await Promise.all([
    runAs(actor, async (ctx) => {
      const page = await listAttachments(ctx, { inbox: true, limit: 100 });
      const out: AttachmentDetail[] = [];
      for (const a of page.data) out.push(a.extracted ? await getAttachment(ctx, { id: a.id }) : { ...a, suggestions: null });
      return out;
    }),
    runAs(actor, (ctx) => bankingChoices(ctx)),
  ]);
  return (
    <AppShell title="Receipts" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <ReceiptsPanel
        receipts={receipts}
        choices={{ bankAccounts: choices.bankAccounts, categories: choices.categories, vendors: choices.vendors }}
        currency={organization.baseCurrency}
        canEdit={hasRole(actor.role, "bookkeeper") && !actor.support}
        reading={readerConfigured()}
        storage={storageConfigured()}
      />
    </AppShell>
  );
}
