"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { LifeBuoy, LogOut, Menu } from "lucide-react";
import { useState } from "react";
import type { FontScale } from "@/lib/ui/font-scale";
import { FontScaleToggle } from "./font-scale-toggle";
import { OrgSwitcher, type SwitcherWorkspace } from "./org-switcher";
import { Brand, SidebarNav } from "./sidebar";

type Props = {
  title: string;
  crumb?: string;
  userEmail?: string | null;
  switcher?: { workspaces: SwitcherWorkspace[]; currentOrgId: string | null; currentWorkspaceId: string | null };
  workspaceAdmin: boolean;
  fontScale: FontScale;
};

export function Topbar({ title, crumb, userEmail, switcher, workspaceAdmin, fontScale }: Props) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <header className="h-16 border-b border-border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/80 px-3 sm:px-6 lg:px-8 flex items-center justify-between gap-3 shrink-0 pt-[env(safe-area-inset-top)] box-content">
      <div className="flex items-center gap-2 min-w-0">
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="md:hidden shrink-0"
                aria-label="Open navigation"
              />
            }
          >
            <Menu className="h-5 w-5" />
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[85vw] max-w-xs p-0 gap-0 bg-sidebar"
          >
            <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[var(--gw-gold)] via-[var(--gw-gold-bright)] to-[var(--gw-gold)]" />
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <div className="px-4 py-4 border-b border-sidebar-border">
              <Brand />
            </div>
            <SidebarNav onNavigate={() => setNavOpen(false)} workspaceAdmin={workspaceAdmin} />
            {/* Account strip on paper so the switcher reads like everywhere else. */}
            <div className="bg-card text-foreground pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="border-t border-border px-4 py-3">
                <FontScaleToggle current={fontScale} variant="labelled" />
              </div>
              {switcher && (
                <div className="border-t border-border px-4 py-3 sm:hidden">
                  <OrgSwitcher {...switcher} />
                </div>
              )}
              {userEmail && (
                <div className="border-t border-border px-4 pt-3 text-xs text-muted-foreground truncate">
                  {userEmail}
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>

        <div className="min-w-0">
          <div className="font-heading text-[17px] sm:text-[16px] tracking-[0.12em] text-foreground truncate leading-tight">
            {title}
          </div>
          {crumb && (
            <div className="text-[10px] tracking-[0.18em] uppercase text-muted-foreground mt-1 truncate">
              {crumb}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {switcher && (
          <div className="hidden sm:block">
            <OrgSwitcher {...switcher} />
          </div>
        )}
        <div className="hidden md:block">
          <FontScaleToggle current={fontScale} />
        </div>
        {userEmail && (
          <span className="hidden xl:inline text-xs text-muted-foreground">
            {userEmail}
          </span>
        )}
        <a
          href="mailto:tyler@tylermbriggs.com?subject=Groundworks%20support"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Contact support"
        >
          <LifeBuoy className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Support</span>
        </a>
        {/* A real POST so the server records the sign-out and ends the session. */}
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="ghost" size="sm" className="gap-1.5" aria-label="Sign out">
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline text-xs">Sign out</span>
          </Button>
        </form>
      </div>
    </header>
  );
}
