"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Form1099Box } from "@/lib/ap/form-1099";
import { setAccountBox } from "./actions";

/** Which 1099 box each expense account's vendor payments report in. */
export function BoxMapping({
  accounts,
  labels,
  canEdit,
}: {
  accounts: Array<{ id: string; code: string; name: string; box: Form1099Box | null }>;
  labels: Record<Form1099Box, string>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function change(id: string, value: string) {
    setErr(null);
    start(async () => {
      const r = await setAccountBox(id, (value || null) as Form1099Box | null);
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto max-h-96">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Expense account</th>
              <th className="text-left font-medium px-3 py-2 w-96">1099 box</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-t border-border">
                <td className="px-3 py-1.5 text-xs">
                  <span className="font-mono text-muted-foreground">{a.code}</span> {a.name}
                </td>
                <td className="px-3 py-1.5">
                  <select
                    value={a.box ?? ""}
                    disabled={!canEdit || pending}
                    onChange={(e) => change(a.id, e.target.value)}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1"
                    aria-label={`1099 box for ${a.code}`}
                  >
                    <option value="">Not reported</option>
                    {(Object.keys(labels) as Form1099Box[]).map((b) => (
                      <option key={b} value={b}>{labels[b]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
