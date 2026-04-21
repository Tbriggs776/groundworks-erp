"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Single-date URL-driven filter. Used by Balance Sheet ("as of") and any
 * other single-date report.
 */
export function DateFilter({
  paramName,
  value,
  label,
}: {
  paramName: string;
  value: string;
  label: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [date, setDate] = useState(value);

  function apply() {
    const next = new URLSearchParams(searchParams.toString());
    next.set(paramName, date);
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="flex items-end gap-3">
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          {label}
        </Label>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
        />
      </div>
      <Button onClick={apply}>Apply</Button>
    </div>
  );
}

/**
 * Date-range filter for reports with from/to. Used by Income Statement and
 * GL Detail.
 */
export function DateRangeFilter({
  fromValue,
  toValue,
  extra,
}: {
  fromValue: string;
  toValue: string;
  extra?: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(fromValue);
  const [to, setTo] = useState(toValue);

  function apply() {
    const next = new URLSearchParams(searchParams.toString());
    next.set("from", from);
    next.set("to", to);
    router.push(`?${next.toString()}`);
  }

  return (
    <div className="flex items-end gap-3 flex-wrap">
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
      {extra}
      <Button onClick={apply}>Apply</Button>
    </div>
  );
}
