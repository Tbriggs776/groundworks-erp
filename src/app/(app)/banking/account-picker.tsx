"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { accountOption, Picker } from "./picker";

/** Switch the page to another bank / card account (keeps the other query params). */
export function AccountPicker({ accounts, value }: { accounts: Array<{ id: string; code: string; name: string }>; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Picker
      className="min-w-64 w-auto"
      ariaLabel="Account"
      options={accounts.map(accountOption)}
      value={value}
      placeholder="Choose account…"
      onChange={(v) => {
        if (!v) return;
        const next = new URLSearchParams(params.toString());
        next.set("account", v);
        next.delete("offset");
        router.push(`${pathname}?${next.toString()}`);
      }}
    />
  );
}
