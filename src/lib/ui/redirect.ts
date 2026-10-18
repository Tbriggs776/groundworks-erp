/**
 * Only same-origin paths. Without this, `?redirectTo=https://evil.example`
 * (or `//evil.example`, or `/\evil.example`, which browsers read as
 * `//evil.example`) would bounce a freshly signed-in user offsite.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  return value;
}
