"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { createOrganization, type CreateOrgState } from "./actions";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function OnboardingForm({ defaultName }: { defaultName?: string }) {
  const [state, action, pending] = useActionState<CreateOrgState, FormData>(
    createOrganization,
    { status: "idle" }
  );

  const nameErrors =
    state.status === "error" ? state.fieldErrors?.name : undefined;
  const fyErrors =
    state.status === "error" ? state.fieldErrors?.fiscalYearStartMonth : undefined;

  return (
    <form action={action} className="space-y-5">
      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Organization name
        </label>
        <input
          name="name"
          type="text"
          required
          defaultValue={defaultName}
          autoFocus
          placeholder="Veritas Ridge Construction"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {nameErrors && (
          <p className="text-xs text-destructive mt-1">{nameErrors[0]}</p>
        )}
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Fiscal year starts
        </label>
        <select
          name="fiscalYearStartMonth"
          defaultValue="1"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {MONTHS.map((m, i) => (
            <option key={i} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground mt-1">
          Most contractors use calendar year (January). Change later in settings.
        </p>
        {fyErrors && (
          <p className="text-xs text-destructive mt-1">{fyErrors[0]}</p>
        )}
      </div>

      <label className="flex items-start gap-2 cursor-pointer group">
        <input
          name="seedContractorCoa"
          type="checkbox"
          defaultChecked
          className="mt-0.5 h-4 w-4 rounded border-border bg-background accent-[var(--gw-gold)]"
        />
        <span>
          <span className="block text-xs font-medium text-foreground">
            Seed the standard contractor Chart of Accounts
          </span>
          <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">
            ~70 accounts covering cash, AR/retainage, WIP, AP, labor + materials +
            sub COGS, overhead, SG&amp;A. You can edit or replace any of it.
          </span>
        </span>
      </label>

      {state.status === "error" && !state.fieldErrors && (
        <p className="text-xs text-destructive">{state.message}</p>
      )}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
