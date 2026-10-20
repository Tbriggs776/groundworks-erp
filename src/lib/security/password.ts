import { z } from "zod";

/**
 * Password rules (NIST 800-63B style: length, no composition rules).
 * Supabase Auth stores the hash and enforces its own minimum, so set
 * Authentication → Providers → Email → "Minimum password length" to match.
 * 72 is bcrypt's limit.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

/** Supabase Auth error messages, in our words. */
export function authErrorMessage(error: { message: string; code?: string }): string {
  switch (error.code) {
    case "invalid_credentials":
      return "That email and password don't match.";
    case "user_already_exists":
    case "email_exists":
      return "That email already has an account. Sign in, or reset the password.";
    case "email_not_confirmed":
      return "Confirm your email first: open the link we sent you.";
    case "weak_password":
      return `Choose a stronger password (at least ${PASSWORD_MIN_LENGTH} characters, not a common one).`;
    case "same_password":
      return "That's your current password. Choose a new one.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return error.message;
  }
}
