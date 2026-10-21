import { hasRole, runAs } from "@/lib/actor";
import { attachmentsFor } from "@/lib/attachments/service";
import { requireActor } from "@/lib/auth";
import type { AttachmentEntity } from "@/lib/db/schema";
import { AttachmentsPanel } from "./attachments-panel";

/** The attachments panel for a document's page. */
export async function AttachmentsSection({ entityType, entityId }: { entityType: AttachmentEntity; entityId: string }) {
  const actor = await requireActor();
  const files = await runAs(actor, (ctx) => attachmentsFor(ctx, entityType, entityId));
  return <AttachmentsPanel entityType={entityType} entityId={entityId} files={files} canEdit={hasRole(actor.role, "bookkeeper") && !actor.support} />;
}
