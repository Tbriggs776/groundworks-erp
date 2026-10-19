"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createAgent } from "./actions";
import { AgentFields, type AgentFormState } from "./agent-fields";

export function NewAgentButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormState>({
    name: "",
    description: "",
    role: "bookkeeper",
    autonomy: "draft",
    maxPostAmount: "",
  });

  function submit() {
    setErr(null);
    start(async () => {
      const r = await createAgent({
        name: form.name,
        description: form.description,
        role: form.role,
        autonomy: form.autonomy,
        maxPostAmount: form.autonomy === "post" && form.maxPostAmount ? form.maxPostAmount : null,
      });
      if (r.ok) router.push(`/settings/agents/${r.id}`);
      else setErr(r.error);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        New agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading tracking-[0.12em]">NEW AGENT</DialogTitle>
          </DialogHeader>
          <AgentFields value={form} onChange={setForm} />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={pending || !form.name.trim()} onClick={submit}>
              {pending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
