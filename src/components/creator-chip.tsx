import { Bot, User } from "lucide-react";
import type { Creator } from "@/lib/ui/creator";

/** Small "created by" chip. Agents get a bot icon so they stand out. */
export function CreatorChip({ creator }: { creator: Creator }) {
  if (!creator) return null;
  const Icon = creator.kind === "agent" ? Bot : User;
  return (
    <span
      className={
        creator.kind === "agent"
          ? "inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px]"
          : "inline-flex items-center gap-1 text-[11px] text-muted-foreground"
      }
    >
      <Icon className="h-3 w-3" />
      {creator.kind === "agent" ? `Agent · ${creator.label}` : creator.label}
    </span>
  );
}
