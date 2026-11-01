"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ALargeSmall } from "lucide-react";
import { setFontScale } from "@/app/ui-actions";
import {
  FONT_SCALES,
  FONT_SCALE_LABELS,
  type FontScale,
} from "@/lib/ui/font-scale";
import { cn } from "@/lib/utils";

/**
 * Three-stop text size switcher. Cozy is the default; the two steps above
 * bump body copy, nav items, tables, and form fields across the whole app.
 * Rendered as a small inline segmented control (and as a labelled row in
 * the mobile drawer); each click writes a cookie and refreshes the tree.
 */
export function FontScaleToggle({
  current,
  variant = "compact",
  className,
}: {
  current: FontScale;
  variant?: "compact" | "labelled";
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const choose = (value: FontScale) => {
    if (value === current || pending) return;
    start(async () => {
      await setFontScale(value);
      router.refresh();
    });
  };

  const sizes: Record<FontScale, string> = {
    cozy: "text-[11px]",
    comfortable: "text-[13px]",
    large: "text-[15px]",
  };

  if (variant === "labelled") {
    return (
      <div className={cn("flex items-center justify-between gap-3", className)}>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <ALargeSmall className="h-4 w-4 text-[var(--gw-gold-deep)]" aria-hidden />
          Text size
        </span>
        <div
          role="radiogroup"
          aria-label="Text size"
          className="inline-flex rounded-md border border-border bg-card p-0.5"
        >
          {FONT_SCALES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={value === current}
              onClick={() => choose(value)}
              disabled={pending}
              className={cn(
                "rounded-sm px-2.5 py-1 font-medium transition-colors",
                sizes[value],
                value === current
                  ? "bg-[var(--gw-navy)] text-white"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {FONT_SCALE_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Text size"
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-card",
        className
      )}
    >
      <ALargeSmall
        className="ml-1.5 h-3.5 w-3.5 text-muted-foreground"
        aria-hidden
      />
      {FONT_SCALES.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={value === current}
          aria-label={`Text size ${FONT_SCALE_LABELS[value]}`}
          onClick={() => choose(value)}
          disabled={pending}
          className={cn(
            "px-1.5 py-0.5 font-semibold transition-colors",
            sizes[value],
            value === current
              ? "text-[var(--gw-navy)]"
              : "text-muted-foreground hover:text-foreground"
          )}
          title={FONT_SCALE_LABELS[value]}
        >
          A
        </button>
      ))}
    </div>
  );
}
