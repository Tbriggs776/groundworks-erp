"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import type { Account } from "@/lib/db/schema";
import {
  createAccount,
  updateAccount,
  type AccountFormState,
} from "./actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Account | null;
};

const SUBCATEGORIES_BY_CATEGORY: Record<
  "balance_sheet" | "income_statement",
  Array<{ value: string; label: string; normal: "debit" | "credit" }>
> = {
  balance_sheet: [
    { value: "cash", label: "Cash", normal: "debit" },
    { value: "receivables", label: "Receivables", normal: "debit" },
    { value: "inventory", label: "Inventory", normal: "debit" },
    { value: "other_current_asset", label: "Other Current Asset", normal: "debit" },
    { value: "fixed_assets", label: "Fixed Assets", normal: "debit" },
    { value: "other_asset", label: "Other Asset", normal: "debit" },
    { value: "payables", label: "Payables", normal: "credit" },
    { value: "accrued_liabilities", label: "Accrued Liabilities", normal: "credit" },
    { value: "other_current_liability", label: "Other Current Liability", normal: "credit" },
    { value: "lt_debt", label: "Long-Term Debt", normal: "credit" },
    { value: "other_liability", label: "Other Liability", normal: "credit" },
    { value: "equity", label: "Equity", normal: "credit" },
    { value: "retained_earnings", label: "Retained Earnings", normal: "credit" },
  ],
  income_statement: [
    { value: "operating_revenue", label: "Operating Revenue", normal: "credit" },
    { value: "other_revenue", label: "Other Revenue", normal: "credit" },
    { value: "cogs_labor", label: "COGS — Labor", normal: "debit" },
    { value: "cogs_materials", label: "COGS — Materials", normal: "debit" },
    { value: "cogs_equipment", label: "COGS — Equipment", normal: "debit" },
    { value: "cogs_subcontractor", label: "COGS — Subcontractor", normal: "debit" },
    { value: "cogs_other", label: "COGS — Other", normal: "debit" },
    { value: "operating_expense", label: "Operating Expense", normal: "debit" },
    { value: "sga", label: "SG&A", normal: "debit" },
    { value: "interest", label: "Interest", normal: "debit" },
    { value: "tax", label: "Tax", normal: "debit" },
    { value: "other_expense", label: "Other Expense", normal: "debit" },
  ],
};

export function AccountForm({ open, onOpenChange, initial }: Props) {
  const isEdit = Boolean(initial);
  const action = isEdit
    ? (prev: AccountFormState, fd: FormData) =>
        updateAccount(initial!.id, prev, fd)
    : createAccount;

  const [state, formAction, pending] = useActionState<AccountFormState, FormData>(
    action,
    { status: "idle" }
  );

  // Auto-close on success.
  if (state.status === "success" && open) {
    // Can't call onOpenChange during render; defer.
    queueMicrotask(() => onOpenChange(false));
  }

  const err = (field: string) =>
    state.status === "error" ? state.fieldErrors?.[field]?.[0] : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em] text-xl">
            {isEdit ? "EDIT ACCOUNT" : "NEW ACCOUNT"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit
              ? `Editing ${initial!.code} — ${initial!.name}`
              : "Add a new account to the Chart of Accounts."}
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <div>
              <Label htmlFor="code" className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Code
              </Label>
              <Input
                id="code"
                name="code"
                required
                defaultValue={initial?.code}
                placeholder="1010"
              />
              {err("code") && (
                <p className="text-xs text-destructive mt-1">{err("code")}</p>
              )}
            </div>
            <div>
              <Label htmlFor="name" className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Name
              </Label>
              <Input
                id="name"
                name="name"
                required
                defaultValue={initial?.name}
                placeholder="Cash — Operating"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="description" className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Description
            </Label>
            <Textarea
              id="description"
              name="description"
              rows={2}
              defaultValue={initial?.description ?? ""}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Category
              </Label>
              <Select name="category" defaultValue={initial?.category ?? "balance_sheet"}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="balance_sheet">Balance Sheet</SelectItem>
                  <SelectItem value="income_statement">Income Statement</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Subcategory
              </Label>
              <Select name="subcategory" defaultValue={initial?.subcategory ?? "cash"}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ...SUBCATEGORIES_BY_CATEGORY.balance_sheet,
                    ...SUBCATEGORIES_BY_CATEGORY.income_statement,
                  ].map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Normal Balance
              </Label>
              <Select name="normalBalance" defaultValue={initial?.normalBalance ?? "debit"}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">Debit</SelectItem>
                  <SelectItem value="credit">Credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Account Type
            </Label>
            <Select name="accountType" defaultValue={initial?.accountType ?? "posting"}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="posting">Posting (accepts journal lines)</SelectItem>
                <SelectItem value="heading">Heading (display-only, no posting)</SelectItem>
                <SelectItem value="total">Total (rollup)</SelectItem>
                <SelectItem value="begin_total">Begin Total</SelectItem>
                <SelectItem value="end_total">End Total</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
            <FlagCheckbox
              name="isActive"
              label="Active"
              defaultChecked={initial?.isActive ?? true}
            />
            <FlagCheckbox
              name="directPosting"
              label="Direct Posting"
              defaultChecked={initial?.directPosting ?? true}
            />
            <FlagCheckbox
              name="isBlocked"
              label="Blocked"
              defaultChecked={initial?.isBlocked ?? false}
            />
            <FlagCheckbox
              name="isControl"
              label="Control Account"
              defaultChecked={initial?.isControl ?? false}
            />
            <FlagCheckbox
              name="isCash"
              label="Cash / Bank"
              defaultChecked={initial?.isCash ?? false}
            />
            <FlagCheckbox
              name="isStatistical"
              label="Statistical"
              defaultChecked={initial?.isStatistical ?? false}
            />
          </div>

          {state.status === "error" && !state.fieldErrors && (
            <p className="text-xs text-destructive">{state.message}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FlagCheckbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer">
      <Checkbox name={name} defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}
