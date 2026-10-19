"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/ui/form-state";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "MXN"];
const field =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const label = "block text-xs uppercase tracking-wider text-muted-foreground mb-1.5";

/** Company setup fields, shared by sign-up onboarding and "Add company". */
export function CompanyForm({
  action,
  defaultName,
  submitLabel,
  askWorkspaceName,
}: {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  defaultName?: string;
  submitLabel: string;
  askWorkspaceName?: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, { status: "idle" });
  const errs = state.status === "error" ? state.fieldErrors : undefined;
  const fieldError = (k: string) => errs?.[k]?.[0] && <p className="text-xs text-destructive mt-1">{errs[k]![0]}</p>;

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label className={label} htmlFor="company-name">Company name</label>
        <input id="company-name" name="name" required defaultValue={defaultName} autoFocus placeholder="Bright Harbor Studio LLC" className={field} />
        {fieldError("name")}
      </div>

      {askWorkspaceName && (
        <div>
          <label className={label} htmlFor="workspace-name">Workspace name (optional)</label>
          <input id="workspace-name" name="workspaceName" placeholder="Same as the company" className={field} />
          <p className="text-[11px] text-muted-foreground mt-1">
            Your account, which can hold several companies (for example &ldquo;Harbor Holdings&rdquo;).
          </p>
          {fieldError("workspaceName")}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label} htmlFor="fy-start">Fiscal year starts</label>
          <select id="fy-start" name="fiscalYearStartMonth" defaultValue="1" className={field}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="currency">Currency</label>
          <select id="currency" name="baseCurrency" defaultValue="USD" className={field}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-start gap-2 cursor-pointer">
        <input name="seedDefaultCoa" type="checkbox" defaultChecked className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-[var(--gw-gold)]" />
        <span>
          <span className="block text-xs font-medium text-foreground">Start with the standard small-business chart of accounts</span>
          <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">
            About 65 accounts laid out like QuickBooks. Uncheck if you&apos;re importing your own. You can edit any of it.
          </span>
        </span>
      </label>

      {state.status === "error" && !errs && <p className="text-xs text-destructive">{state.message}</p>}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : submitLabel}
      </Button>
    </form>
  );
}
