"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { FONT_SCALE_COOKIE, isFontScale, type FontScale } from "@/lib/ui/font-scale";

const COOKIE = {
  httpOnly: false,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

/**
 * Save the viewer's font scale preference. It applies to every page the
 * next time the server renders, so the caller refreshes afterwards.
 */
export async function setFontScale(value: FontScale): Promise<void> {
  if (!isFontScale(value)) return;
  (await cookies()).set(FONT_SCALE_COOKIE, value, COOKIE);
  revalidatePath("/", "layout");
}
