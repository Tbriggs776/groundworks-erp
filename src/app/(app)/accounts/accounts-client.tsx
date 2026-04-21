"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Search } from "lucide-react";
import type { Account } from "@/lib/db/schema";
import { AccountForm } from "./account-form";

export function AccountsClient({ accounts }: { accounts: Account[] }) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "posting" | "heading" | "total">("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (typeFilter !== "all" && a.accountType !== typeFilter) return false;
      if (!q) return true;
      return (
        a.code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.subcategory.includes(q)
      );
    });
  }, [accounts, query, typeFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by code, name, or subcategory…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="text-xs bg-background border border-border rounded-md px-2 py-2"
          >
            <option value="all">All types</option>
            <option value="posting">Posting</option>
            <option value="heading">Heading</option>
            <option value="total">Total</option>
          </select>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          New Account
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-24">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-36">Subcategory</th>
              <th className="text-left font-medium px-3 py-2 w-20">Balance</th>
              <th className="text-left font-medium px-3 py-2 w-40">Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-xs text-muted-foreground"
                >
                  No accounts match.
                </td>
              </tr>
            )}
            {filtered.map((a) => (
              <tr
                key={a.id}
                onClick={() => {
                  setEditing(a);
                  setFormOpen(true);
                }}
                className="border-t border-border hover:bg-accent/30 cursor-pointer transition-colors"
              >
                <td className="px-3 py-2 font-mono text-xs text-primary">
                  {a.code}
                </td>
                <td className="px-3 py-2">
                  <div className={a.isBlocked ? "opacity-50" : ""}>{a.name}</div>
                  {a.description && (
                    <div className="text-[11px] text-muted-foreground truncate max-w-md">
                      {a.description}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {a.subcategory.replace(/_/g, " ")}
                </td>
                <td className="px-3 py-2 text-xs uppercase tracking-wider">
                  {a.normalBalance === "debit" ? "Dr" : "Cr"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 flex-wrap">
                    {!a.isActive && (
                      <Badge variant="outline" className="text-[9px]">
                        Inactive
                      </Badge>
                    )}
                    {a.isBlocked && (
                      <Badge variant="destructive" className="text-[9px]">
                        Blocked
                      </Badge>
                    )}
                    {a.isControl && (
                      <Badge variant="secondary" className="text-[9px]">
                        Control
                      </Badge>
                    )}
                    {a.isCash && (
                      <Badge variant="secondary" className="text-[9px]">
                        Cash
                      </Badge>
                    )}
                    {a.isStatistical && (
                      <Badge variant="secondary" className="text-[9px]">
                        Stat
                      </Badge>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {filtered.length} of {accounts.length} accounts. Click a row to edit.
      </div>

      <AccountForm
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
      />
    </div>
  );
}
