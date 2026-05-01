"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const STATUSES = [
  { code: "draft", label: "Draft" },
  { code: "issued", label: "Issued" },
  { code: "closed", label: "Closed" },
  { code: "voided", label: "Voided" },
] as const;

function Inner({ activeFilter }: { activeFilter: string[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const set = new Set(activeFilter);

  function toggle(code: string) {
    const next = new Set(set);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    const sp = new URLSearchParams(params.toString());
    sp.delete("status");
    for (const s of next) sp.append("status", s);
    router.push(`?${sp.toString()}`);
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {STATUSES.map((s) => {
        const on = set.has(s.code);
        return (
          <button
            key={s.code}
            onClick={() => toggle(s.code)}
            className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border ${
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export function CommitmentStatusFilter({
  activeFilter,
}: {
  activeFilter: string[];
}) {
  return (
    <Suspense fallback={null}>
      <Inner activeFilter={activeFilter} />
    </Suspense>
  );
}
