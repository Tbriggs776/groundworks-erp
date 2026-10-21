import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { plaid } from "./plaid";

/**
 * Plaid signs every webhook: the Plaid-Verification header is a JWT (ES256)
 * whose key Plaid serves by id, carrying the SHA-256 of the body and when
 * it was issued. A webhook is believed only when the signature checks out,
 * it's under five minutes old, and the body is the one that was signed.
 */

const MAX_AGE_SECONDS = 5 * 60;
const keys = new Map<string, JsonWebKey>();

type Jwk = JsonWebKey & { kid?: string; expired_at?: number | null };

async function keyFor(kid: string): Promise<JsonWebKey | null> {
  const cached = keys.get(kid);
  if (cached) return cached;
  try {
    const { key } = await plaid<{ key: Jwk }>("/webhook_verification_key/get", { key_id: kid });
    if (!key || key.expired_at) return null;
    keys.set(kid, key);
    return key;
  } catch {
    return null;
  }
}

const decode = <T>(part: string): T | null => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
};

export async function verifyPlaidWebhook(rawBody: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const header = decode<{ alg?: string; kid?: string }>(h);
  if (header?.alg !== "ES256" || !header.kid) return false;
  const jwk = await keyFor(header.kid);
  if (!jwk) return false;
  let ok = false;
  try {
    ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  } catch {
    return false;
  }
  if (!ok) return false;
  const claims = decode<{ iat?: number; request_body_sha256?: string }>(p);
  if (!claims?.iat || Math.abs(Date.now() / 1000 - claims.iat) > MAX_AGE_SECONDS || !claims.request_body_sha256) return false;
  const want = Buffer.from(createHash("sha256").update(rawBody).digest("hex"));
  const got = Buffer.from(claims.request_body_sha256);
  return want.length === got.length && timingSafeEqual(want, got);
}
