import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";

/**
 * Sealing secrets the app has to read back (QuickBooks tokens): AES-256-GCM
 * under APP_ENCRYPTION_KEY (32 random bytes, base64). A sealed value is
 * "v1.<iv>.<tag>.<ciphertext>", all base64url; tampering fails to open.
 * Signing (HMAC-SHA256 under a key derived from the same secret) protects
 * values the browser carries, like an OAuth state.
 */

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new AppError("invalid_state", "APP_ENCRYPTION_KEY isn't set, so secrets can't be stored. Add 32 random bytes, base64 encoded.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new AppError("invalid_state", "APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  return k;
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new AppError("invalid_state", "A stored secret is unreadable.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

const signingKey = () => createHmac("sha256", key()).update("groundworks-signing-v1").digest();

/** "<payload>.<signature>", payload base64url JSON. */
export function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", signingKey()).update(body).digest("base64url")}`;
}

/** The payload if the signature is ours, else null. */
export function verifySigned<T>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", signingKey()).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
