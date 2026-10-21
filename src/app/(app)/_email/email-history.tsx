import { runAs, type Actor } from "@/lib/actor";
import { listEmails } from "@/lib/messaging/service";

type DocType = "invoice" | "estimate" | "sales_receipt" | "credit_memo" | "purchase_order" | "statement";

const STATUS: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  delayed: "Delayed",
  bounced: "Bounced",
  complained: "Marked as spam",
  failed: "Not sent",
};

/** A document's emails, newest first: to whom, when, by whom, and what became of each. */
export async function EmailHistory({ actor, documentType, documentId }: { actor: Actor; documentType: DocType; documentId: string }) {
  const { data } = await runAs(actor, (ctx) => listEmails(ctx, { documentType, documentId, limit: 20 }));
  if (data.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Emails</h2>
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Sent</th>
              <th className="text-left font-medium px-3 py-2">To</th>
              <th className="text-left font-medium px-3 py-2">Subject</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-left font-medium px-3 py-2">By</th>
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(m.sentAt).toLocaleString()}</td>
                <td className="px-3 py-2 text-xs">{[...m.to, ...m.cc].join(", ")}</td>
                <td className="px-3 py-2 text-xs">
                  {m.kind === "reminder" && <span className="text-muted-foreground">Reminder · </span>}
                  {m.subject}
                </td>
                <td className={`px-3 py-2 text-xs ${m.status === "failed" || m.status === "bounced" || m.status === "complained" ? "text-destructive" : ""}`}>
                  {STATUS[m.status]}
                  {m.openedAt && m.status !== "bounced" && <span className="text-muted-foreground"> · opened{m.openCount > 1 ? ` ${m.openCount} times` : ""}</span>}
                  {m.error && <div className="text-[11px] text-muted-foreground">{m.error}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{m.sentByAgent ? `${m.sentByAgent} (agent)` : (m.sentByEmail ?? "Automatic")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
