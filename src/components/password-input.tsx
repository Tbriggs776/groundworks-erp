"use client";

import { useId, useState } from "react";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/security/password";

export const authInputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm normal-case tracking-normal text-foreground outline-none focus:ring-2 focus:ring-ring";

/**
 * Labelled password field with a Show / Hide toggle. `isNew` switches the
 * browser hint to "suggest a strong password" and adds the length rule.
 */
export function PasswordInput({
  label,
  value,
  onChange,
  isNew = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  isNew?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={id}
          type={shown ? "text" : "password"}
          required
          autoFocus={autoFocus}
          autoComplete={isNew ? "new-password" : "current-password"}
          minLength={isNew ? PASSWORD_MIN_LENGTH : undefined}
          maxLength={PASSWORD_MAX_LENGTH}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${authInputClass} pr-16`}
        />
        <button
          type="button"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 px-3 text-xs text-muted-foreground hover:text-foreground"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {isNew && (
        <p className="mt-1 text-[11px] text-muted-foreground">At least {PASSWORD_MIN_LENGTH} characters.</p>
      )}
    </div>
  );
}
