import { createHash, randomBytes } from "node:crypto";

/**
 * API key format: `gwk_` + 40 base62 characters (~238 bits of entropy).
 *
 *   gwk_7Hq2…   ← shown once, at creation
 *   gwk_7Hq2xYz9 ← `prefix` (first 12 chars), stored for display/support
 *
 * Only SHA-256(token) is stored. A slow hash (bcrypt/argon2) buys nothing
 * for a random 238-bit secret and would add ~250ms to every API call.
 */
export const KEY_PREFIX = "gwk_";
const BODY_LENGTH = 40;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateApiKey(): { token: string; prefix: string; secretHash: string } {
  // Rejection sampling keeps the distribution uniform over the alphabet.
  let body = "";
  while (body.length < BODY_LENGTH) {
    for (const byte of randomBytes(BODY_LENGTH * 2)) {
      if (byte < 248) body += ALPHABET[byte % 62];
      if (body.length === BODY_LENGTH) break;
    }
  }
  const token = `${KEY_PREFIX}${body}`;
  return { token, prefix: token.slice(0, 12), secretHash: hashApiKey(token) };
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX) && token.length === KEY_PREFIX.length + BODY_LENGTH;
}
