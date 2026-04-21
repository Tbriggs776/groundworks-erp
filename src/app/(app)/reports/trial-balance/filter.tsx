"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export function TrialBalanceFilter({
  asOfDate,
  includeZero,
}: {
  asOfDate: string;
  includeZero: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [date, setDate] = useState(asOfDate);
  const [zero, setZero] = useState(includeZero);

  function apply() {
    const next = new URLSearchParams(searchParams.toString());
    next.set("asOf", date);
    if (zero) next.set("includeZero", "1");
    else next.delete("includeZero");
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="flex items-end gap-3">
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          As of date
        </Label>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
        />
      </div>
      <label className="flex items-center gap-2 text-xs pb-2 cursor-pointer">
        <Checkbox
          checked={zero}
          onCheckedChange={(c) => setZero(!!c)}
        />
        <span>Include zero-balance accounts</span>
      </label>
      <Button onClick={apply}>Apply</Button>
    </div>
  );
}
