"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { ImportResult } from "@/lib/banking/review";
import { importStatement } from "../actions";
import { Picker } from "../picker";

const MAX_BYTES = 4 * 1024 * 1024;

/** Upload a CSV / OFX / QFX export from the bank into For review. */
export function ImportStatement({ accountId, accountName }: { accountId: string; accountName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [flipSigns, setFlipSigns] = useState(false);
  const [dateFormat, setDateFormat] = useState("auto");
  const [applyRules, setApplyRules] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setFile(null);
    setErr(null);
    setResult(null);
  }

  function submit() {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setErr("That file is over 4 MB. Export a shorter date range and import it in parts.");
      return;
    }
    setErr(null);
    start(async () => {
      const content = await file.text();
      const r = await importStatement({
        accountId,
        content,
        fileName: file.name,
        flipSigns,
        applyRules,
        dateFormat: dateFormat === "auto" ? undefined : (dateFormat as "MDY" | "DMY" | "YMD"),
      });
      if (!r.ok) setErr(r.error);
      else {
        setResult(r.result);
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => { reset(); setOpen(true); }}>
        <Upload className="h-3.5 w-3.5" /> Import statement
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import a statement</DialogTitle>
            <DialogDescription>
              Into {accountName}. Download a CSV, OFX, QFX, or Web Connect file from the bank&apos;s website. Lines already imported are skipped, so overlapping date ranges are fine.
            </DialogDescription>
          </DialogHeader>

          {!result ? (
            <div className="space-y-4">
              <div>
                <Label htmlFor="statement-file" className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">File</Label>
                <input
                  id="statement-file"
                  type="file"
                  accept=".csv,.ofx,.qfx,.qbo,.txt,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-semibold"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Dates in a CSV</Label>
                  <Picker
                    ariaLabel="Date format"
                    value={dateFormat}
                    onChange={setDateFormat}
                    options={[
                      { value: "auto", label: "Detect automatically" },
                      { value: "MDY", label: "Month first (03/31/2026)" },
                      { value: "DMY", label: "Day first (31/03/2026)" },
                      { value: "YMD", label: "Year first (2026-03-31)" },
                    ]}
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={flipSigns} onCheckedChange={(v) => setFlipSigns(v === true)} className="mt-0.5" />
                <span>
                  Charges show as positive numbers
                  <span className="block text-[11px] text-muted-foreground">Common in credit card CSVs. Flips every amount.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={applyRules} onCheckedChange={(v) => setApplyRules(v === true)} className="mt-0.5" />
                <span>
                  Run bank rules on the new lines
                  <span className="block text-[11px] text-muted-foreground">Auto-add rules record their lines right away.</span>
                </span>
              </label>
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <p>
                <span className="font-semibold">{result.newCount}</span> new line{result.newCount === 1 ? "" : "s"}
                {result.duplicateCount > 0 && <>, {result.duplicateCount} already imported</>}.
              </p>
              {(result.rules.autoAdded > 0 || result.rules.categorized > 0) && (
                <p className="text-xs text-muted-foreground">
                  Rules recorded {result.rules.autoAdded} and suggested a category for {result.rules.categorized}.
                  {result.rules.autoAddHeld > 0 && <> {result.rules.autoAddHeld} were held for review.</>}
                </p>
              )}
              {result.ledgerBalance && <p className="text-xs text-muted-foreground">The bank reports a balance of {result.ledgerBalance}.</p>}
              {result.skipped.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Skipped {result.skipped.length} row{result.skipped.length === 1 ? "" : "s"}:
                  <ul className="list-disc pl-5 mt-1 max-h-32 overflow-y-auto">
                    {result.skipped.slice(0, 20).map((s) => (
                      <li key={s.row}>Row {s.row}: {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {!result ? (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button disabled={!file || pending} onClick={submit}>{pending ? "Importing…" : "Import"}</Button>
              </>
            ) : (
              <Button onClick={() => setOpen(false)}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
