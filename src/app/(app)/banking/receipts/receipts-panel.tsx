"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Loader2, RotateCw, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACCEPT, shrinkImage } from "@/components/attachments/shrink";
import type { AttachmentDetail, MatchSuggestion } from "@/lib/attachments/service";
import { formatMoney } from "@/lib/money";
import { deleteFile, expenseFromReceipt, linkFile, readFile, uploadFile } from "../../files/actions";
import type { Choice } from "../choices";
import { accountOption, Picker } from "../picker";

/**
 * The Receipts inbox: drop in receipts, Claude reads them, and each one is
 * attached to what it matches (a bank line waiting in For review, an
 * expense, a bill) or recorded as a new expense.
 */

const KIND: Record<MatchSuggestion["kind"], string> = {
  statement_line: "Bank line in For review",
  bank_transaction: "Expense",
  bill: "Bill",
};

export function ReceiptsPanel({
  receipts,
  choices,
  currency,
  canEdit,
  reading,
  storage,
}: {
  receipts: AttachmentDetail[];
  choices: { bankAccounts: Choice[]; categories: Choice[]; vendors: Choice[] };
  currency: string;
  canEdit: boolean;
  reading: boolean;
  storage: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recorded, setRecorded] = useState<{ id: string; review: boolean } | null>(null);
  const waiting = receipts.some((r) => r.readStatus === "pending");

  // Reading runs after the upload returns: look again until it's done.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [waiting, router]);

  const upload = (list: FileList | File[] | null) =>
    start(async () => {
      const errs: string[] = [];
      for (const f of Array.from(list ?? [])) {
        const form = new FormData();
        form.set("file", await shrinkImage(f));
        form.set("path", "/banking/receipts");
        const r = await uploadFile(form);
        if (!r.ok) errs.push(`${f.name}: ${r.error}`);
        else if (r.file.duplicateOf) errs.push(`${f.name} was uploaded before${r.file.duplicateOf.entityLabel ? ` (on a ${r.file.duplicateOf.entityLabel.toLowerCase()})` : ""}. Delete this copy if you don't need it.`);
      }
      setErrors(errs);
      if (input.current) input.current.value = "";
      router.refresh();
    });

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Upload receipts and bills.{" "}
          {reading
            ? "Claude reads each one (vendor, date, total, card), then you attach it to the bank line or expense it belongs to, or record it as a new expense."
            : "Then attach each one to the bank line or expense it belongs to, or record it as a new expense."}{" "}
          Receipts attached to a bank line in{" "}
          <Link href="/banking/review" className="text-primary hover:underline">
            For review
          </Link>{" "}
          follow it into the books.
        </p>
        {canEdit && storage && (
          <>
            <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" aria-label="Upload receipts" onChange={(e) => upload(e.target.files)} />
            <Button onClick={() => input.current?.click()} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload receipts
            </Button>
          </>
        )}
      </div>

      {!storage && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">File storage isn&apos;t set up for this app yet (SUPABASE_SERVICE_ROLE_KEY).</div>
      )}
      {storage && !reading && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Receipt reading isn&apos;t set up (ANTHROPIC_API_KEY), so fill in the details yourself when you record one.
        </div>
      )}
      {errors.map((e) => (
        <div key={e} className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          {e}
        </div>
      ))}
      {recorded && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {recorded.review ? "Saved as a draft for review, with the receipt attached." : "Recorded, with the receipt attached."}{" "}
          <Link href={`/banking/transactions/${recorded.id}`} className="text-primary hover:underline">
            View the expense
          </Link>
        </div>
      )}

      {canEdit && storage && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            upload(e.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm text-muted-foreground ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
        >
          Drop receipts here: PDFs and photos up to 4 MB each.
        </div>
      )}

      {receipts.length === 0 ? (
        <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">No receipts waiting.</div>
      ) : (
        receipts.map((r) => (
          <ReceiptCard key={r.id} r={r} choices={choices} currency={currency} canEdit={canEdit} reading={reading} onRecorded={setRecorded} />
        ))
      )}
    </div>
  );
}

function ReceiptCard({
  r,
  choices,
  currency,
  canEdit,
  reading,
  onRecorded,
}: {
  r: AttachmentDetail;
  choices: { bankAccounts: Choice[]; categories: Choice[]; vendors: Choice[] };
  currency: string;
  canEdit: boolean;
  reading: boolean;
  onRecorded: (t: { id: string; review: boolean }) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const f = r.extracted;
  const s = r.suggestions;
  const [bankAccountId, setBankAccountId] = useState(s?.bankAccount?.id ?? "");
  const [categoryAccountId, setCategoryAccountId] = useState(s?.categoryAccount?.id ?? "");
  const [vendorId, setVendorId] = useState(s?.vendor?.id ?? "");
  const [payeeName, setPayeeName] = useState(f?.vendorName ?? "");
  const [txnDate, setTxnDate] = useState(f?.date ?? "");
  const [amount, setAmount] = useState(f?.total ?? "");
  const fmt = (v: string) => formatMoney(v, { currency });
  const readable = r.contentType === "application/pdf" || r.contentType.startsWith("image/");

  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
      router.refresh();
    });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap gap-4">
        <a href={r.url} target="_blank" rel="noreferrer" className="shrink-0" aria-label={`Open ${r.fileName}`}>
          {r.contentType.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.url} alt="" className="h-24 w-20 rounded border border-border object-cover" />
          ) : (
            <span className="flex h-24 w-20 items-center justify-center rounded border border-border bg-muted">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </span>
          )}
        </a>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{f?.vendorName ?? r.fileName}</span>
            {f?.total && <span className="font-mono text-sm">{fmt(f.total)}</span>}
            {f?.documentType && f.documentType !== "receipt" && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] capitalize">{f.documentType}</span>}
          </div>
          {r.readStatus === "pending" && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading…
            </div>
          )}
          {r.readStatus === "failed" && <div className="text-xs text-destructive">Couldn&apos;t read it: {r.readError}</div>}
          {f && (
            <div className="text-xs text-muted-foreground">
              {[
                f.date,
                f.tax && `tax ${fmt(f.tax)}`,
                f.tip && `tip ${fmt(f.tip)}`,
                f.paymentMethod && f.paymentMethod.replace("_", " "),
                f.cardLast4 && `card ••${f.cardLast4}`,
                f.reference && `#${f.reference}`,
                f.description,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
          <div className="text-[11px] text-muted-foreground">
            {r.fileName}
            {r.uploadedByAgent ? " · uploaded by an agent" : ""}
          </div>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-start gap-1">
            {reading && readable && r.readStatus !== "pending" && (
              <Button size="icon-xs" variant="ghost" aria-label="Read again" title="Read again" disabled={pending} onClick={() => act(() => readFile(r.id, "/banking/receipts"))}>
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete ${r.fileName}`}
              disabled={pending}
              onClick={() => window.confirm(`Delete ${r.fileName}?`) && act(() => deleteFile(r.id, "/banking/receipts"))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {error && <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">{error}</div>}

      {s && s.matches.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3 w-3" /> Looks like
          </div>
          {s.matches.map((m) => (
            <div key={`${m.kind}:${m.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{KIND[m.kind]}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {m.date} · {fmt(m.amount.replace(/^-/, ""))} · {m.description}
                  {m.account ? ` · ${m.account}` : ""}
                </span>{" "}
                <Link href={m.href} className="text-xs text-primary hover:underline">
                  View
                </Link>
              </div>
              {canEdit && (
                <Button size="xs" disabled={pending} onClick={() => act(() => linkFile(r.id, m.kind, m.id, "/banking/receipts"))}>
                  Attach
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && r.readStatus !== "pending" && (
        <div className="mt-3">
          {!recording ? (
            <Button size="sm" variant="outline" onClick={() => setRecording(true)}>
              Record as a new expense
            </Button>
          ) : (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div>
                  <Label className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Paid from</Label>
                  <Picker ariaLabel="Paid from" options={choices.bankAccounts.map(accountOption)} value={bankAccountId} onChange={setBankAccountId} placeholder="Bank or card…" />
                </div>
                <div>
                  <Label className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Category</Label>
                  <Picker ariaLabel="Category" options={choices.categories.map(accountOption)} value={categoryAccountId} onChange={setCategoryAccountId} placeholder="Choose category…" />
                </div>
                <div>
                  <Label className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Vendor</Label>
                  <Picker ariaLabel="Vendor" options={choices.vendors.map((v) => ({ value: v.id, label: v.name }))} value={vendorId} onChange={setVendorId} placeholder="Optional" />
                </div>
                {!vendorId && (
                  <div>
                    <Label className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Or a payee name</Label>
                    <Input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="As on the receipt" />
                  </div>
                )}
                <div>
                  <Label className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Date</Label>
                  <Input type="date" aria-label="Date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
                </div>
                <div>
                  <Label className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Amount</Label>
                  <Input
                    inputMode="decimal"
                    aria-label="Amount"
                    className="text-right font-mono"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setRecording(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={pending || !bankAccountId || !categoryAccountId || !txnDate || !amount}
                  onClick={() =>
                    act(async () => {
                      const res = await expenseFromReceipt({
                        id: r.id,
                        bankAccountId,
                        categoryAccountId,
                        vendorId: vendorId || undefined,
                        payeeName: vendorId ? undefined : payeeName || undefined,
                        txnDate,
                        amount,
                      });
                      if (res.ok) onRecorded({ id: res.transactionId, review: Boolean(res.review) });
                      return res;
                    })
                  }
                >
                  Record {amount ? fmt(amount) : "expense"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
