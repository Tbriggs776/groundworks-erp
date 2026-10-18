"use client";

import { AUTONOMY_INFO } from "@/components/autonomy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type AgentFormState = {
  name: string;
  description: string;
  role: "accountant" | "bookkeeper" | "viewer";
  autonomy: "read" | "draft" | "post";
  maxPostAmount: string;
};

/** Shared fields for creating and editing an agent. */
export function AgentFields({
  value,
  onChange,
  disabled,
}: {
  value: AgentFormState;
  onChange: (v: AgentFormState) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<AgentFormState>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Name</Label>
          <Input value={value.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} placeholder="Billing assistant" />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Role</Label>
          <select
            value={value.role}
            disabled={disabled}
            onChange={(e) => set({ role: e.target.value as AgentFormState["role"] })}
            className="w-full text-sm bg-background border border-border rounded-md px-2 py-2"
          >
            <option value="bookkeeper">Bookkeeper</option>
            <option value="accountant">Accountant</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">What it&apos;s for</Label>
        <Textarea
          rows={2}
          value={value.description}
          disabled={disabled}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Turns emailed vendor invoices into draft bills"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Autonomy</Label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(Object.keys(AUTONOMY_INFO) as Array<keyof typeof AUTONOMY_INFO>).map((k) => (
            <button
              key={k}
              type="button"
              disabled={disabled}
              onClick={() => set({ autonomy: k })}
              className={`text-left rounded-md border p-3 transition-colors ${
                value.autonomy === k ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
              }`}
            >
              <div className="text-sm font-semibold">{AUTONOMY_INFO[k].label}</div>
              <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{AUTONOMY_INFO[k].summary}</div>
            </button>
          ))}
        </div>
      </div>
      {value.autonomy === "post" && (
        <div className="max-w-xs">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Posting limit per document</Label>
          <Input
            inputMode="decimal"
            value={value.maxPostAmount}
            disabled={disabled}
            onChange={(e) => set({ maxPostAmount: e.target.value })}
            placeholder="e.g. 500.00 (blank = no limit)"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1">Anything larger is saved as a draft for review.</p>
        </div>
      )}
    </div>
  );
}
