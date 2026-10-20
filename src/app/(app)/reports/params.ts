import { format, startOfYear } from "date-fns";

/** A YYYY-MM-DD search param, or the fallback. */
export function dateParam(v: string | undefined, fallback: string): string {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

/** Year to date: the default range for period reports. */
export function ytd(sp: { from?: string; to?: string }) {
  return {
    from: dateParam(sp.from, format(startOfYear(new Date()), "yyyy-MM-dd")),
    to: dateParam(sp.to, format(new Date(), "yyyy-MM-dd")),
  };
}

/** A uuid search param, or undefined. */
export function idParam(v: string | undefined): string | undefined {
  return v && /^[0-9a-f-]{36}$/.test(v) ? v : undefined;
}
