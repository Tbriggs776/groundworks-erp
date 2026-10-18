import type { Ctx } from "@/lib/actor";
import { AppError } from "@/lib/errors";

/**
 * "Create and post" for callers that may not be allowed to post.
 *
 * When a create call asks for post=true but the actor can't post (no post
 * scope) or the amount is over an agent's posting limit, we keep the draft
 * and say so instead of failing the whole call: the document lands in the
 * review queue, and the agent gets a clear `review` notice to relay.
 */
export type ReviewNotice = { review: { required: true; reason: string } };

export async function postOrQueueForReview<T extends object>(
  ctx: Ctx,
  post: (ctx: Ctx) => Promise<T>,
  current: () => Promise<T>
): Promise<T & Partial<ReviewNotice>> {
  if (!ctx.actor.scopes.includes("post")) {
    return {
      ...(await current()),
      review: {
        required: true,
        reason: "This credential can draft but not post. Saved as a draft; a human will review and post it.",
      },
    };
  }
  try {
    // Savepoint: a refused post rolls back only the post, never the draft.
    return await ctx.tx.transaction((sp) => post({ actor: ctx.actor, tx: sp }));
  } catch (err) {
    if (err instanceof AppError && err.code === "approval_required") {
      return { ...(await current()), review: { required: true, reason: err.message } };
    }
    throw err;
  }
}
