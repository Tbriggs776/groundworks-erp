"use client";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

type Props = {
  title: string;
  crumb?: string;
  userEmail?: string | null;
};

export function Topbar({ title, crumb, userEmail }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function signOut() {
    start(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/auth/login");
      router.refresh();
    });
  }

  return (
    <header className="h-14 border-b border-border bg-card px-6 flex items-center justify-between shrink-0">
      <div>
        <div className="font-heading text-[15px] tracking-[0.18em] text-foreground">
          {title}
        </div>
        {crumb && (
          <div className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground mt-0.5">
            {crumb}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        {userEmail && (
          <span className="text-xs text-muted-foreground">{userEmail}</span>
        )}
        <Button
          onClick={signOut}
          disabled={pending}
          variant="ghost"
          size="sm"
          className="gap-1.5"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="text-xs">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
