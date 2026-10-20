"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { deleteCompanyLogo, saveCompanyProfile, uploadCompanyLogo } from "./actions";

type Fields = {
  legalName: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  taxId: string;
  documentFooter: string;
  checkOffsetX: string;
  checkOffsetY: string;
};

const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";

export function CompanyProfileForm({
  canEdit,
  companyName,
  logo,
  maxLogoKb,
  initial,
}: {
  canEdit: boolean;
  companyName: string;
  logo: string | null;
  maxLogoKb: number;
  initial: Fields;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState<Fields>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: done } : { ok: false, text: r.error ?? "Failed." });
      if (r.ok) router.refresh();
    });
  }

  function save() {
    run(
      () =>
        saveCompanyProfile({
          legalName: f.legalName,
          address: { street1: f.street1, street2: f.street2, city: f.city, state: f.state, zip: f.zip, country: f.country },
          phone: f.phone,
          email: f.email,
          website: f.website,
          taxId: f.taxId,
          documentFooter: f.documentFooter,
          checkOffsetX: f.checkOffsetX || "0",
          checkOffsetY: f.checkOffsetY || "0",
        }),
      "Saved."
    );
  }

  function pickLogo(file: File | undefined) {
    if (!file) return;
    if (file.size > maxLogoKb * 1024) {
      setMsg({ ok: false, text: `That file is ${Math.ceil(file.size / 1024)} KB; the limit is ${maxLogoKb} KB.` });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      run(() => uploadCompanyLogo(file.type, base64), "Logo saved.");
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-4">
      {msg && (
        <p role="status" className={`text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Logo</div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="h-20 w-48 rounded-md border border-dashed border-border bg-background flex items-center justify-center overflow-hidden">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL preview, nothing for next/image to optimize
              <img src={logo} alt="Company logo" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">No logo</span>
            )}
          </div>
          {canEdit && (
            <div className="flex flex-col gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                aria-label="Logo file"
                onChange={(e) => pickLogo(e.target.files?.[0])}
                className="text-xs"
                disabled={pending}
              />
              <p className="text-[11px] text-muted-foreground">PNG or JPEG, {maxLogoKb} KB at most. Wide logos print best.</p>
              {logo && (
                <Button size="sm" variant="ghost" className="self-start" disabled={pending} onClick={() => run(() => deleteCompanyLogo(), "Logo removed.")}>
                  Remove logo
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Company details</div>
        <fieldset disabled={!canEdit || pending} className="space-y-3">
          <div>
            <Label className={label}>Name on documents</Label>
            <Input value={f.legalName} onChange={set("legalName")} placeholder={companyName} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className={label}>Street</Label>
              <Input value={f.street1} onChange={set("street1")} aria-label="Street" />
            </div>
            <div>
              <Label className={label}>Suite, unit</Label>
              <Input value={f.street2} onChange={set("street2")} placeholder="Optional" />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="col-span-2">
              <Label className={label}>City</Label>
              <Input value={f.city} onChange={set("city")} aria-label="City" />
            </div>
            <div>
              <Label className={label}>State</Label>
              <Input value={f.state} onChange={set("state")} aria-label="State" />
            </div>
            <div>
              <Label className={label}>ZIP</Label>
              <Input value={f.zip} onChange={set("zip")} aria-label="ZIP" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className={label}>Phone</Label>
              <Input value={f.phone} onChange={set("phone")} aria-label="Phone" />
            </div>
            <div>
              <Label className={label}>Email</Label>
              <Input type="email" value={f.email} onChange={set("email")} aria-label="Email" />
            </div>
            <div>
              <Label className={label}>Website</Label>
              <Input value={f.website} onChange={set("website")} aria-label="Website" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className={label}>Country</Label>
              <Input value={f.country} onChange={set("country")} placeholder="Optional" />
            </div>
            <div className="sm:col-span-2">
              <Label className={label}>Tax ID</Label>
              <Input value={f.taxId} onChange={set("taxId")} placeholder="Optional: EIN or sales tax permit, printed under the address" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className={label}>Checks: move right (in)</Label>
              <Input inputMode="decimal" value={f.checkOffsetX} onChange={set("checkOffsetX")} aria-label="Check offset right" />
            </div>
            <div>
              <Label className={label}>Checks: move down (in)</Label>
              <Input inputMode="decimal" value={f.checkOffsetY} onChange={set("checkOffsetY")} aria-label="Check offset down" />
            </div>
            <p className="text-[11px] text-muted-foreground sm:pt-6">
              If printed checks land off the lines, nudge them here. Negative numbers move left or up.
            </p>
          </div>
          <div>
            <Label className={label}>Footer on every document</Label>
            <Textarea
              value={f.documentFooter}
              onChange={set("documentFooter")}
              rows={3}
              placeholder="Thank you for your business. Make checks payable to…"
            />
          </div>
        </fieldset>
        {canEdit ? (
          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Only admins can change the company profile.</p>
        )}
      </div>
    </div>
  );
}
