"use client";

import { useEffect } from "react";
import { keepAlive } from "@/app/(app)/account/security/actions";

/**
 * The idle timeout counts real activity, not just page loads: while the
 * person types or clicks, touch the session at most every 4 minutes, so a
 * long invoice doesn't get them signed out mid-form.
 */
export function KeepAlive() {
  useEffect(() => {
    let last = Date.now();
    const onActivity = () => {
      if (Date.now() - last < 4 * 60_000) return;
      last = Date.now();
      keepAlive().catch(() => undefined);
    };
    const events = ["keydown", "pointerdown", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, onActivity));
  }, []);
  return null;
}
