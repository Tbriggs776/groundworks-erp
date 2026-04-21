import bcrypt from "bcryptjs";

/**
 * Password hashing for in-app secondary secrets (e.g., the hard-close
 * override password stored on `organizations.hard_close_override_password_hash`).
 *
 * Not for user login passwords — user auth is handled by Supabase Auth.
 * This is only for secondary passwords set BY users within their own org.
 *
 * Cost factor 12 is the 2025 recommendation for bcrypt (~250ms on a modern
 * server). Bump if/when hardware improves.
 */
const BCRYPT_COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
