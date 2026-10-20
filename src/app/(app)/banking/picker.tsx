"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type PickerOption = { value: string; label: string };

/**
 * A Select that shows the chosen option's label (Base UI shows the raw
 * value unless it's given the items up front).
 */
export function Picker({
  options,
  value,
  onChange,
  placeholder = "Choose…",
  className,
  size,
  ariaLabel,
}: {
  options: PickerOption[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "default";
  ariaLabel?: string;
}) {
  return (
    <Select items={options} value={value || null} onValueChange={(v) => onChange((v as string | null) ?? "")}>
      <SelectTrigger size={size} className={cn("w-full", className)} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const accountOption = (a: { id: string; code?: string; name: string }): PickerOption => ({
  value: a.id,
  label: a.code ? `${a.code} · ${a.name}` : a.name,
});
