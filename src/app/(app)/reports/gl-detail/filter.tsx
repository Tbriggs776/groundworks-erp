"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Account } from "@/lib/db/schema";

export function GlDetailFilter({
  accounts,
  accountId,
  fromDate,
  toDate,
}: {
  accounts: Account[];
  accountId: string;
  fromDate: string;
  toDate: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [account, setAccount] = useState(accountId);
  const [from, setFrom] = useState(fromDate);
  const [to, setTo] = useState(toDate);

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting"
  );

  function apply() {
    const next = new URLSearchParams(searchParams.toString());
    if (account) next.set("account", account);
    else next.delete("account");
    next.set("from", from);
    next.set("to", to);
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="flex items-end gap-3 flex-wrap">
      <div className="min-w-72">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Account
        </Label>
        <select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          className="w-full text-sm bg-background border border-border rounded-md px-2 py-2"
        >
          <option value="">— choose account —</option>
          {postingAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          From
        </Label>
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-44"
        />
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          To
        </Label>
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-44"
        />
      </div>
      <Button disabled={!account} onClick={apply}>
        Apply
      </Button>
    </div>
  );
}
