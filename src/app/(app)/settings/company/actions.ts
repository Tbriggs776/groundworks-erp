"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as profile from "@/lib/company/profile";

/** Company profile server actions: thin wrappers over src/lib/company/profile.ts. */

export async function saveCompanyProfile(input: profile.UpdateCompanyProfileInput): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    await profile.updateCompanyProfile(ctx, input);
    return { id: ctx.actor.organizationId };
  });
  if (r.ok) revalidatePath("/settings/company");
  return r;
}

export async function uploadCompanyLogo(contentType: string, base64: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    await profile.setCompanyLogo(ctx, { contentType: contentType as "image/png", base64 });
    return { id: ctx.actor.organizationId };
  });
  if (r.ok) revalidatePath("/settings/company");
  return r;
}

export async function deleteCompanyLogo(): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    await profile.removeCompanyLogo(ctx);
    return { id: ctx.actor.organizationId };
  });
  if (r.ok) revalidatePath("/settings/company");
  return r;
}
