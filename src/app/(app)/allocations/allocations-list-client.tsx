"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Account, AllocationGroup } from "@/lib/db/schema";
import { RunAllocationDialog } from "./run-dialog";

type GroupRow = AllocationGroup & { targetCount: number };

export function AllocationsListClient({
  groups,
  accounts,
}: {
  groups: GroupRow[];
  accounts: Account[];
}) {
  const [running, setRunning] = useState<GroupRow | null>(null);

  return (
    <>
      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-36">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-28">Type</th>
              <th className="text-left font-medium px-3 py-2 w-28">Targets</th>
              <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              <th className="text-right font-medium px-3 py-2 w-28">Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  No allocations configured yet.
                </td>
              </tr>
            )}
            {groups.map((g) => (
              <tr key={g.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">
                  <Link
                    href={`/allocations/${g.id}`}
                    className="text-primary hover:underline"
                  >
                    {g.code}
                  </Link>
                </td>
                <td className="px-3 py-2">{g.name}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground capitalize">
                  {g.allocationType}
                </td>
                <td className="px-3 py-2 text-xs">{g.targetCount}</td>
                <td className="px-3 py-2">
                  {g.isActive ? (
                    <Badge variant="default" className="text-[9px]">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px]">
                      Inactive
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRunning(g)}
                    disabled={!g.isActive}
                  >
                    Run
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {running && (
        <RunAllocationDialog
          open={!!running}
          onOpenChange={(o) => !o && setRunning(null)}
          groupId={running.id}
          groupName={running.name}
          accounts={accounts}
        />
      )}
    </>
  );
}
