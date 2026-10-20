import { Badge } from "@/components/ui/badge";

/**
 * One badge for every document lifecycle (bills, invoices, payments,
 * journals, estimates, recurring templates) so the same word always looks
 * the same.
 */
const VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  pending_approval: "secondary",
  rejected: "destructive",
  approved: "secondary",
  open: "default",
  posted: "default",
  paid: "secondary",
  voided: "outline",
  reversed: "outline",
  overdue: "destructive",
  pending: "secondary",
  accepted: "default",
  closed: "outline",
  active: "default",
  paused: "outline",
  ended: "outline",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={VARIANT[status] ?? "outline"} className="text-[9px] capitalize">
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
