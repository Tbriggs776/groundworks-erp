import type { AccessSnapshot } from "@/lib/workspace/service";

const th = "text-left font-medium px-3 py-2";
const td = "px-3 py-2";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "Never";
}

/** Read-only rendering of who has access to what (live or a past review). */
export function SnapshotView({ snapshot }: { snapshot: AccessSnapshot }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">People ({snapshot.people.length})</div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className={th}>Person</th><th className={th}>Workspace</th><th className={th}>Companies</th><th className={th}>2-step</th><th className={th}>Last seen</th></tr>
            </thead>
            <tbody>
              {snapshot.people.map((p) => (
                <tr key={p.userId} className={`border-t border-border ${p.active ? "" : "opacity-60"}`}>
                  <td className={td}>{p.name ?? p.email}{p.name && <div className="text-[11px] text-muted-foreground">{p.email}</div>}{!p.active && <div className="text-[10px] text-muted-foreground">Removed</div>}</td>
                  <td className={`${td} capitalize text-xs`}>{p.workspaceRole}</td>
                  <td className={`${td} text-xs`}>{p.companies.length ? p.companies.map((c) => `${c.company}: ${c.role}`).join(" · ") : "None"}</td>
                  <td className={`${td} text-xs`}>{p.mfa === null ? "Unknown" : p.mfa ? "On" : <span className="text-[var(--gw-amber-bright)]">Off</span>}</td>
                  <td className={`${td} text-xs text-muted-foreground`}>{when(p.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Agents ({snapshot.agents.length})</div>
        {snapshot.agents.length === 0 ? <p className="text-xs text-muted-foreground">No agents.</p> : (
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr><th className={th}>Agent</th><th className={th}>Company</th><th className={th}>Role</th><th className={th}>Autonomy</th><th className={th}>Last active</th></tr>
              </thead>
              <tbody>
                {snapshot.agents.map((a) => (
                  <tr key={a.id} className={`border-t border-border ${a.active ? "" : "opacity-60"}`}>
                    <td className={td}>{a.name}{!a.active && <span className="text-[10px] text-muted-foreground"> (inactive)</span>}</td>
                    <td className={`${td} text-xs`}>{a.company}</td>
                    <td className={`${td} text-xs capitalize`}>{a.role}</td>
                    <td className={`${td} text-xs`}>{a.autonomy}{a.maxPostAmount ? ` up to ${Number(a.maxPostAmount).toFixed(2)}` : ""}</td>
                    <td className={`${td} text-xs text-muted-foreground`}>{when(a.lastActiveAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Live API keys ({snapshot.apiKeys.length})</div>
        {snapshot.apiKeys.length === 0 ? <p className="text-xs text-muted-foreground">No live keys.</p> : (
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr><th className={th}>Key</th><th className={th}>Company</th><th className={th}>Belongs to</th><th className={th}>Scopes</th><th className={th}>Expires</th><th className={th}>Last used</th></tr>
              </thead>
              <tbody>
                {snapshot.apiKeys.map((k) => (
                  <tr key={k.id} className="border-t border-border">
                    <td className={td}>{k.name}<div className="font-mono text-[10px] text-muted-foreground">{k.prefix}…</div></td>
                    <td className={`${td} text-xs`}>{k.company}</td>
                    <td className={`${td} text-xs`}>{k.owner}</td>
                    <td className={`${td} text-xs`}>{k.scopes.join(", ")}</td>
                    <td className={`${td} text-xs`}>{k.expiresAt ? when(k.expiresAt) : <span className="text-[var(--gw-amber-bright)]">Never</span>}</td>
                    <td className={`${td} text-xs text-muted-foreground`}>{when(k.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
