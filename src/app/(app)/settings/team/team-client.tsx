"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InvitationRow, MemberRow } from "@/lib/team/service";
import { inviteMember, revokeInvite, updateMember } from "./actions";

const ROLES: Array<{ value: MemberRow["role"]; label: string; hint: string }> = [
  { value: "owner", label: "Owner", hint: "Everything, including other owners" },
  { value: "admin", label: "Admin", hint: "Team, agents, API keys, settings, voids" },
  { value: "accountant", label: "Accountant", hint: "Journal entries, approvals, posting bills, period close" },
  { value: "bookkeeper", label: "Bookkeeper", hint: "Invoices, bills, payments, customers, vendors" },
  { value: "viewer", label: "Viewer", hint: "Read-only: reports and lists" },
];

const select = "text-xs bg-background border border-border rounded-md px-2 py-1.5";

export function TeamClient({
  members,
  invites,
  canManage,
  isOwner,
  currentUserId,
}: {
  members: MemberRow[];
  invites: InvitationRow[];
  canManage: boolean;
  isOwner: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRow["role"]>("bookkeeper");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function run<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, after?: (r: T) => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.(r);
        router.refresh();
      }
    });
  }

  const assignable = ROLES.filter((r) => isOwner || r.value !== "owner");
  // Captured once so the render stays pure; good enough for "expired?".
  const [renderedAt] = useState(() => Date.now());

  return (
    <div className="space-y-8 max-w-4xl">
      <section className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">People</div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Member</th>
                <th className="text-left font-medium px-3 py-2 w-40">Role</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
                <th className="w-28"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.userId === currentUserId;
                const editable = canManage && (isOwner || m.role !== "owner");
                return (
                  <tr key={m.membershipId} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div>{m.fullName ?? m.email}</div>
                      {m.fullName && <div className="text-[11px] text-muted-foreground">{m.email}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {editable ? (
                        <select
                          value={m.role}
                          disabled={pending}
                          onChange={(e) =>
                            run(() => updateMember(m.membershipId, { role: e.target.value as MemberRow["role"] }))
                          }
                          className={select}
                        >
                          {assignable.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs capitalize">{m.role}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={m.isActive ? "secondary" : "outline"} className="text-[9px]">
                        {m.isActive ? "Active" : "Deactivated"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editable && !self && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => run(() => updateMember(m.membershipId, { isActive: !m.isActive }))}
                        >
                          {m.isActive ? "Deactivate" : "Reactivate"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-muted-foreground">
          {ROLES.map((r) => (
            <li key={r.value}>
              <span className="text-foreground">{r.label}:</span> {r.hint}
            </li>
          ))}
        </ul>
      </section>

      {canManage && (
        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Invite someone</div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-56">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Role</Label>
              <select value={role} onChange={(e) => setRole(e.target.value as MemberRow["role"])} className={`${select} py-2`}>
                {assignable.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <Button
              disabled={pending || !email.includes("@")}
              onClick={() =>
                run(
                  () => inviteMember({ email, role }),
                  (r) => {
                    if ("link" in r) setLink(r.link as string);
                    setEmail("");
                    setCopied(false);
                  }
                )
              }
            >
              <UserPlus className="h-3.5 w-3.5" />
              Create invite link
            </Button>
          </div>
          {link && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="text-xs">
                Send this link to them. It works once, for that email address, for 7 days. It won&apos;t be shown again.
              </div>
              <div className="flex gap-2">
                <Input readOnly value={link} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(link);
                    setCopied(true);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Pending invite</th>
                    <th className="text-left font-medium px-3 py-2 w-32">Role</th>
                    <th className="text-left font-medium px-3 py-2 w-40">Expires</th>
                    <th className="w-40"></th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => {
                    const expired = new Date(i.expiresAt).getTime() < renderedAt;
                    return (
                      <tr key={i.id} className="border-t border-border">
                        <td className="px-3 py-2 font-mono text-xs">{i.email}</td>
                        <td className="px-3 py-2 text-xs capitalize">{i.role}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {expired ? "Expired" : new Date(i.expiresAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2 text-right space-x-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() =>
                              run(
                                () => inviteMember({ email: i.email, role: i.role }),
                                (r) => {
                                  if ("link" in r) setLink(r.link as string);
                                  setCopied(false);
                                }
                              )
                            }
                          >
                            New link
                          </Button>
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revokeInvite(i.id))}>
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}
