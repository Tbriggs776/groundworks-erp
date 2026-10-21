"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { emailDraftAction, sendEmailAction } from "./actions";

type DocType = "invoice" | "estimate" | "sales_receipt" | "credit_memo" | "purchase_order" | "statement";
const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";
const list = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Email a document (or a payment reminder): review the recipients and message, then send with the PDF attached. */
export function EmailButton({
  documentType,
  documentId,
  reminder,
  statement,
  children,
}: {
  documentType: DocType;
  documentId: string;
  reminder?: boolean;
  statement?: { from: string; to: string };
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [loading, setLoading] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [onFile, setOnFile] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const base = { documentType, documentId, reminder, statementFrom: statement?.from, statementTo: statement?.to };

  async function openDialog() {
    setOpen(true);
    setMsg(null);
    setLoading(true);
    const r = await emailDraftAction(base);
    setLoading(false);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error });
      return;
    }
    setTo(r.to.join(", "));
    setCc("");
    setSubject(r.subject);
    setMessage(r.message);
    setOnFile(r.onFile);
    setReplyTo(r.replyTo);
    if (!r.configured) setMsg({ ok: false, text: "Email isn't set up for this app yet. Ask your administrator to add RESEND_API_KEY and EMAIL_FROM." });
  }

  function send() {
    setMsg(null);
    start(async () => {
      const r = await sendEmailAction({ ...base, to: list(to), cc: list(cc), subject, message }, path);
      if (!r.ok) setMsg({ ok: false, text: r.error });
      else if (r.email.status === "failed") setMsg({ ok: false, text: `Not sent: ${r.email.error ?? "the email service refused it"}` });
      else {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Mail className="h-3.5 w-3.5" />
        {children ?? (reminder ? "Send reminder" : "Email")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading tracking-[0.12em]">{reminder ? "SEND PAYMENT REMINDER" : "EMAIL"}</DialogTitle>
            <DialogDescription className="text-xs">
              The PDF is attached.{replyTo ? ` Replies go to ${replyTo}.` : ""}
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <Label className={label}>To</Label>
                <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
                {onFile.length > 1 && <p className="text-[11px] text-muted-foreground mt-1">On file: {onFile.join(", ")}</p>}
              </div>
              <div>
                <Label className={label}>CC</Label>
                <Input value={cc} onChange={(e) => setCc(e.target.value)} />
              </div>
              <div>
                <Label className={label}>Subject</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div>
                <Label className={label}>Message</Label>
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={8} />
              </div>
            </div>
          )}
          {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>{msg.text}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || loading || !to.trim() || !subject.trim() || !message.trim()} onClick={send}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
