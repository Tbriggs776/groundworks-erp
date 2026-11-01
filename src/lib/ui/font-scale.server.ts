import { cookies } from "next/headers";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_COOKIE,
  isFontScale,
  type FontScale,
} from "./font-scale";

/** Read the signed-in viewer's font scale from the cookie jar. */
export async function getFontScale(): Promise<FontScale> {
  const value = (await cookies()).get(FONT_SCALE_COOKIE)?.value;
  return isFontScale(value) ? value : DEFAULT_FONT_SCALE;
}
