import Link from "next/link";
import { cn } from "@/lib/utils";

/** Small presentational pieces the banking pages share. No state, safe on server and client. */

export function Stat({ label, value, hint, alert }: { label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-sm mt-0.5", alert && "text-destructive")}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-2">{children}</div>;
}

export function PillLink({ href, children, primary }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border hover:bg-muted"
      )}
    >
      {children}
    </Link>
  );
}

/** The four ways money moves that aren't bills or customer payments. */
export function NewTransactionLinks({ accountId }: { accountId?: string }) {
  const q = accountId ? `&account=${accountId}` : "";
  return (
    <div className="flex flex-wrap gap-2">
      <PillLink href={`/banking/transactions/new?type=expense${q}`} primary>New expense</PillLink>
      <PillLink href={`/banking/transactions/new?type=check${q}`}>Write check</PillLink>
      <PillLink href={`/banking/transactions/new?type=deposit${q}`}>Deposit</PillLink>
      <PillLink href={`/banking/transactions/new?type=transfer${q}`}>Transfer</PillLink>
    </div>
  );
}

/** C = cleared, R = reconciled, the way every bank register shows it. */
export function ClearMark({ state }: { state: "cleared" | "reconciled" | null }) {
  if (!state) return <span className="text-muted-foreground/40">·</span>;
  return (
    <span
      title={state === "reconciled" ? "Reconciled" : "Cleared"}
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold",
        state === "reconciled" ? "bg-primary text-primary-foreground" : "border border-primary text-primary"
      )}
    >
      {state === "reconciled" ? "R" : "C"}
    </span>
  );
}

export const TXN_TYPE_LABEL: Record<string, string> = {
  expense: "Expense",
  check: "Check",
  deposit: "Deposit",
  transfer: "Transfer",
};
