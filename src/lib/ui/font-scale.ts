/**
 * Font scale preference. "cozy" is the default, "comfortable" bumps body
 * copy for easier reading, "large" is the biggest step, meant for anyone
 * who needs more room to read numbers. Stored in a long-lived cookie so
 * every request can set `data-font-scale` on `<html>` and avoid a flash.
 *
 * This module is safe to import from client components. The server-side
 * reader (`getFontScale`) lives in `./font-scale.server.ts`.
 */
export const FONT_SCALES = ["cozy", "comfortable", "large"] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export const FONT_SCALE_COOKIE = "gw_font_scale";
export const DEFAULT_FONT_SCALE: FontScale = "cozy";

export function isFontScale(value: string | undefined | null): value is FontScale {
  return !!value && (FONT_SCALES as readonly string[]).includes(value);
}

export const FONT_SCALE_LABELS: Record<FontScale, string> = {
  cozy: "Cozy",
  comfortable: "Comfortable",
  large: "Large",
};
