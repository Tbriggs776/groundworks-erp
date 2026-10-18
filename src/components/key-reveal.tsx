"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shows a freshly minted API key exactly once, with copy-paste snippets for
 * connecting it: Claude Code, any MCP client config, and plain REST.
 */
export function KeyReveal({ token, origin }: { token: string; origin: string }) {
  const [tab, setTab] = useState<"claude" | "json" | "curl">("claude");
  const [copied, setCopied] = useState<string | null>(null);

  const snippets = {
    claude: `claude mcp add --transport http groundworks ${origin}/api/mcp \\\n  --header "Authorization: Bearer ${token}"`,
    json: JSON.stringify(
      {
        mcpServers: {
          groundworks: {
            command: "npx",
            args: ["-y", "mcp-remote", `${origin}/api/mcp`, "--header", `Authorization: Bearer ${token}`],
          },
        },
      },
      null,
      2
    ),
    curl: `curl ${origin}/api/v1/me \\\n  -H "Authorization: Bearer ${token}"\n\n# Full spec: ${origin}/api/v1/openapi.json`,
  };

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
  }

  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="text-xs">
        <strong>Copy this key now.</strong> It won&apos;t be shown again; only its first 12 characters are kept for reference.
      </div>
      <div className="flex gap-2">
        <code className="flex-1 min-w-0 truncate rounded-md border border-border bg-background px-2 py-2 text-xs font-mono">
          {token}
        </code>
        <Button variant="outline" onClick={() => copy("key", token)}>
          <Copy className="h-3.5 w-3.5" />
          {copied === "key" ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex gap-1 text-xs">
        {(
          [
            ["claude", "Claude Code"],
            ["json", "MCP config (Cursor, Claude Desktop…)"],
            ["curl", "REST API"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-md px-2.5 py-1 ${tab === k ? "bg-primary/15 text-primary font-semibold" : "text-muted-foreground hover:bg-accent"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-[11px] leading-relaxed font-mono whitespace-pre">
          {snippets[tab]}
        </pre>
        <Button size="sm" variant="ghost" className="absolute top-1.5 right-1.5" onClick={() => copy(tab, snippets[tab])}>
          {copied === tab ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
