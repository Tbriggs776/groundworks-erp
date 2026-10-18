"use client";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { LogOut, Menu } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { OrgSwitcher } from "./org-switcher";
import { Brand, SidebarNav } from "./sidebar";

type Props = {
  title: string;
  crumb?: string;
  userEmail?: string | null;
  org?: { current: string; orgs: Array<{ id: string; name: string }> };
};

export function Topbar({ title, crumb, userEmail, org }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [navOpen, setNavOpen] = useState(false);

  function signOut() {
    start(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/auth/login");
      router.refresh();
    });
  }

  return (
    <header className="h-14 border-b border-border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/80 px-3 sm:px-6 flex items-center justify-between gap-3 shrink-0 pt-[env(safe-area-inset-top)] box-content">
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
            <div className="px-4 py-4 border-b border-border">
              <Brand />
            </div>
            <SidebarNav onNavigate={() => setNavOpen(false)} />
            {org && (
              <div className="border-t border-border px-4 py-3 sm:hidden">
                <OrgSwitcher current={org.current} orgs={org.orgs} />
              </div>
            )}
            {userEmail && (
              <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground truncate pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {userEmail}
              </div>
            )}
          </SheetContent>
        </Sheet>

        <div className="min-w-0">
          <div className="font-heading text-[17px] sm:text-[15px] tracking-[0.18em] text-foreground truncate leading-tight">
            {title}
          </div>
          {crumb && (
            <div className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground mt-0.5 truncate">
              {crumb}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {org && (
          <div className="hidden sm:block">
            <OrgSwitcher current={org.current} orgs={org.orgs} />
          </div>
        )}
        {userEmail && (
          <span className="hidden lg:inline text-xs text-muted-foreground">
            {userEmail}
          </span>
        )}
        <Button
          onClick={signOut}
          disabled={pending}
          variant="ghost"
          size="sm"
          className="gap-1.5"
          aria-label="Sign out"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="hidden sm:inline text-xs">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
