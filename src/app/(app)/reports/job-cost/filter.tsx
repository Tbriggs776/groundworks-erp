"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function Inner({ includeClosed }: { includeClosed: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  function toggle() {
    const next = new URLSearchParams(params.toString());
    if (includeClosed) next.delete("includeClosed");
    else next.set("includeClosed", "1");
    router.push(`?${next.toString()}`);
  }

  return (
    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
      <input
        type="checkbox"
        checked={includeClosed}
        onChange={toggle}
        className="h-3 w-3"
      />
      <span className="uppercase tracking-wider text-muted-foreground">
        Include closed jobs
      </span>
    </label>
  );
}

export function JobCostReportFilter({
  includeClosed,
}: {
  includeClosed: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <Inner includeClosed={includeClosed} />
    </Suspense>
  );
}
