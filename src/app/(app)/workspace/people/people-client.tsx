"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ShieldCheck, ShieldOff, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Role, WorkspaceRole } from "@/lib/actor";
import type { InvitationRow, PersonRow } from "@/lib/workspace/service";
import { invitePerson, revokeInvite, setAccess, setPersonActive, setWorkspaceRole } from "./actions";

const COMPANY_ROLES: Array<{ value: Role; label: string; hint: string }> = [
  { value: "owner", label: "Owner", hint: "Everything in the company" },
  { value: "admin", label: "Admin", hint: "Agents, API keys, settings, voids" },
  { value: "accountant", label: "Accountant", hint: "Journal entries, approvals, period close" },
  { value: "bookkeeper", label: "Bookkeeper", hint: "Invoices, bills, payments, customers, vendors" },
  { value: "viewer", label: "Viewer", hint: "Read only: reports and lists" },
];

const WORKSPACE_ROLES: Array<{ value: WorkspaceRole; label: string; hint: string }> = [
  { value: "owner", label: "Owner", hint: "Everything, including other owners" },
  { value: "admin", label: "Admin", hint: "People, company access, new companies, security" },
  { value: "member", label: "Member", hint: "Works in the companies they're given" },
];

const select = "text-xs bg-background border border-border rounded-md px-2 py-1.5";

type Company = { id: string; name: string };

function relative(d: Date | null, now: number): string {
  if (!d) return "Never";
  const mins = Math.round((now - new Date(d).getTime()) / 60000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)} h ago`;
  return new Date(d).toLocaleDateString();
}

export function PeopleClient({
  people,
  companies,
  invites,
  canManage,
  isOwner,
  currentUserId,
  defaultCompanyId,
  emailEnabled,
}: {
  people: PersonRow[];
  companies: Company[];
  invites: InvitationRow[];
  canManage: boolean;
  isOwner: boolean;
  currentUserId: string;
  defaultCompanyId: string | null;
  emailEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Captured once so render stays pure.
  const [now] = useState(() => Date.now());

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else router.refresh();
    });
  }

  const wsRoles = WORKSPACE_ROLES.filter((r) => isOwner || r.value !== "owner");

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">People and company access</div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 min-w-56">Person</th>
                <th className="text-left font-medium px-3 py-2 w-32">Workspace</th>
                {companies.map((c) => (
                  <th key={c.id} className="text-left font-medium px-3 py-2 min-w-32 normal-case tracking-normal">
                    {c.name}
                  </th>
                ))}
                <th className="w-28"></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const self = p.userId === currentUserId;
                const editable = canManage && p.isActive && (isOwner || p.role !== "owner");
                return (
                  <tr key={p.userId} className={`border-t border-border ${p.isActive ? "" : "opacity-60"}`}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span>{p.fullName ?? p.email}</span>
                        {self && <span className="text-[10px] text-muted-foreground">(you)</span>}
                      </div>
                      {p.fullName && <div className="text-[11px] text-muted-foreground">{p.email}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        {p.mfaEnabled === true ? (
                          <span className="inline-flex items-center gap-0.5 text-[var(--gw-green-bright)]"><ShieldCheck className="h-3 w-3" />2-step on</span>
                        ) : p.mfaEnabled === false ? (
                          <span className="inline-flex items-center gap-0.5"><ShieldOff className="h-3 w-3" />2-step off</span>
                        ) : null}
                        {(canManage || self) && <span>· seen {relative(p.lastSeenAt, now)}</span>}
                        {!p.isActive && <Badge variant="outline" className="text-[9px]">Removed</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {editable ? (
                        <select
                          aria-label={`Workspace role for ${p.email}`}
                          value={p.role}
                          disabled={pending}
                          onChange={(e) => run(() => setWorkspaceRole(p.userId, e.target.value as WorkspaceRole))}
                          className={select}
                        >
                          {wsRoles.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs capitalize">{p.role}</span>
                      )}
                    </td>
                    {companies.map((c) => {
                      const role = p.companies[c.id] ?? null;
                      return (
                        <td key={c.id} className="px-3 py-2">
                          {canManage && p.isActive && (isOwner || p.role !== "owner" || self) ? (
                            <select
                              aria-label={`${c.name} access for ${p.email}`}
                              value={role ?? ""}
                              disabled={pending}
                              onChange={(e) => run(() => setAccess(p.userId, c.id, (e.target.value || null) as Role | null))}
                              className={`${select} ${role ? "" : "text-muted-foreground"}`}
                            >
                              <option value="">No access</option>
                              {COMPANY_ROLES.map((r) => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-xs capitalize">{role ?? "—"}</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">
                      {canManage && !self && (isOwner || p.role !== "owner") && (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setPersonActive(p.userId, !p.isActive))}>
                          {p.isActive ? "Remove" : "Restore"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="grid gap-x-6 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-2">
          {[...WORKSPACE_ROLES.map((r) => ({ ...r, scope: "Workspace" })), ...COMPANY_ROLES.map((r) => ({ ...r, scope: "Company" }))].map((r) => (
            <div key={`${r.scope}-${r.value}`}>
              <span className="text-foreground">{r.scope} {r.label.toLowerCase()}:</span> {r.hint}
            </div>
          ))}
        </div>
        {canManage && (
          <p className="text-[11px] text-muted-foreground">
            Removing someone closes every company to them at once, including their personal API keys. Agents they set up keep working; review them on each company&apos;s Agents page.
          </p>
        )}
      </section>

      {canManage && (
        <InviteSection
          companies={companies}
          invites={invites}
          isOwner={isOwner}
          defaultCompanyId={defaultCompanyId}
          emailEnabled={emailEnabled}
          pending={pending}
          run={run}
          now={now}
        />
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

function InviteSection({
  companies,
  invites,
  isOwner,
  defaultCompanyId,
  emailEnabled,
  pending,
  run,
  now,
}: {
  companies: Company[];
  invites: InvitationRow[];
  isOwner: boolean;
  defaultCompanyId: string | null;
  emailEnabled: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  now: number;
}) {
  const [email, setEmail] = useState("");
  const [wsRole, setWsRole] = useState<WorkspaceRole>("member");
  const [grants, setGrants] = useState<Record<string, Role | "">>(() =>
    defaultCompanyId ? { [defaultCompanyId]: "bookkeeper" } : {}
  );
  const [outcome, setOutcome] = useState<{ email: string; link: string; emailed: boolean; note?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  const send = (input: Parameters<typeof invitePerson>[0]) =>
    run(async () => {
      const r = await invitePerson(input);
      if (r.ok) {
        setOutcome({ email: r.email, link: r.link, emailed: r.emailed, note: r.note });
        setCopied(false);
        setEmail("");
      }
      return r;
    });

  return (
    <section className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Invite someone</div>
      <div className="rounded-md border border-border p-4 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-56 text-xs uppercase tracking-wider text-muted-foreground">
            Email
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className="mt-1.5 normal-case tracking-normal" />
          </label>
          <label className="text-xs uppercase tracking-wider text-muted-foreground">
            Workspace role
            <select value={wsRole} onChange={(e) => setWsRole(e.target.value as WorkspaceRole)} className={`${select} py-2 mt-1.5 block normal-case tracking-normal`}>
              {WORKSPACE_ROLES.filter((r) => isOwner || r.value !== "owner").map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
        </div>
        {companies.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {companies.map((c) => (
              <label key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="truncate">{c.name}</span>
                <select
                  aria-label={`Invite access to ${c.name}`}
                  value={grants[c.id] ?? ""}
                  onChange={(e) => setGrants((g) => ({ ...g, [c.id]: e.target.value as Role | "" }))}
                  className={select}
                >
                  <option value="">No access</option>
                  {COMPANY_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={pending || !email.includes("@")}
            onClick={() =>
              send({
                email,
                workspaceRole: wsRole,
                grants: Object.entries(grants)
                  .filter(([, role]) => role)
                  .map(([organizationId, role]) => ({ organizationId, role: role as Role })),
              })
            }
          >
            <UserPlus className="h-3.5 w-3.5" />
            {emailEnabled ? "Send invite" : "Create invite link"}
          </Button>
          <span className="text-[11px] text-muted-foreground">Links work once, for that email address, for 7 days.</span>
        </div>
      </div>

      {outcome && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
          <div className="text-xs">
            {outcome.emailed
              ? `Invitation emailed to ${outcome.email}. You can also share this link; it won't be shown again.`
              : `Send this link to ${outcome.email}. It won't be shown again.${outcome.note ? ` (${outcome.note})` : ""}`}
          </div>
          <div className="flex gap-2">
            <Input readOnly value={outcome.link} className="font-mono text-xs" aria-label="Invitation link" />
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(outcome.link);
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
                <th className="text-left font-medium px-3 py-2">Access</th>
                <th className="text-left font-medium px-3 py-2 w-32">Expires</th>
                <th className="w-44"></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => {
                const expired = new Date(i.expiresAt).getTime() < now;
                return (
                  <tr key={i.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{i.email}</div>
                      {i.invitedByEmail && <div className="text-[10px] text-muted-foreground">by {i.invitedByEmail}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="capitalize">{i.workspaceRole}</span>
                      {i.grants.map((g) => (
                        <span key={g.organizationId} className="text-muted-foreground">
                          {" · "}
                          {companyName.get(g.organizationId) ?? "Company"}: <span className="capitalize">{g.role}</span>
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {expired ? "Expired" : new Date(i.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right space-x-1 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => send({ email: i.email, workspaceRole: i.workspaceRole, grants: i.grants })}
                      >
                        Resend
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
  );
}
