import { Badge } from "@/components/ui/badge";

export const AUTONOMY_INFO = {
  read: {
    label: "Read only",
    summary: "Looks things up and runs reports. Can't create or change anything.",
  },
  draft: {
    label: "Draft for review",
    summary:
      "Creates customers, invoices, bills, payments, and journal drafts. Nothing hits the ledger until a person posts it from the review queue.",
  },
  post: {
    label: "Post",
    summary:
      "Posts to the ledger within its role, up to its per-document limit. Anything bigger waits in the review queue. Agents can never void, manage people, or mint keys.",
  },
} as const;

export function AutonomyBadge({ autonomy }: { autonomy: keyof typeof AUTONOMY_INFO }) {
  return (
    <Badge
      variant={autonomy === "post" ? "default" : autonomy === "draft" ? "secondary" : "outline"}
      className="text-[9px]"
    >
      {AUTONOMY_INFO[autonomy].label}
    </Badge>
  );
}
