"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Currency } from "@/lib/db/schema";
import { createExchangeRate } from "./actions";

export function NewRateButton({ currencies }: { currencies: Currency[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>+ New rate</Button>
      <RateDialog open={open} onOpenChange={setOpen} currencies={currencies} />
    </>
  );
}

function RateDialog({
  open,
  onOpenChange,
  currencies,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  currencies: Currency[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [fromCurrency, setFromCurrency] = useState("EUR");
  const [toCurrency, setToCurrency] = useState("USD");
  const [rateType, setRateType] = useState("spot");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [rate, setRate] = useState("");
  const [inverseRate, setInverseRate] = useState("");

  function submit() {
    setErr(null);
    start(async () => {
      const r = await createExchangeRate({
        fromCurrency,
        toCurrency,
        rateType: rateType as "spot",
        effectiveDate,
        rate,
        inverseRate: inverseRate || undefined,
      });
      if (r.ok) {
        onOpenChange(false);
        setRate("");
        setInverseRate("");
        router.refresh();
      } else {
        setErr(r.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            NEW EXCHANGE RATE
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                From
              </Label>
              <Select
                value={fromCurrency}
                onValueChange={(v) => setFromCurrency(v ?? "")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                To
              </Label>
              <Select
                value={toCurrency}
                onValueChange={(v) => setToCurrency(v ?? "")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Rate type
              </Label>
              <Select
                value={rateType}
                onValueChange={(v) => setRateType(v ?? "spot")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="spot">Spot</SelectItem>
                  <SelectItem value="average">Average</SelectItem>
                  <SelectItem value="historical">Historical</SelectItem>
                  <SelectItem value="budget">Budget</SelectItem>
                  <SelectItem value="consolidation">Consolidation</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Effective date
              </Label>
              <Input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Rate ({fromCurrency} → {toCurrency})
              </Label>
              <Input
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="1.0850"
                className="font-mono"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Inverse (auto if blank)
              </Label>
              <Input
                inputMode="decimal"
                value={inverseRate}
                onChange={(e) => setInverseRate(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || !rate} onClick={submit}>
            {pending ? "Saving…" : "Save rate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
