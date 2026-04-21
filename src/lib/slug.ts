/**
 * Deterministic slug from a string. Kept dependency-free for now — covers
 * ASCII + basic unicode-to-ascii for common cases. If we need true unicode
 * transliteration later, switch to `@sindresorhus/slugify`.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/**
 * Random 6-char suffix for disambiguating duplicate slugs.
 * Alphanumeric, lowercase, no ambiguous chars (no 0/o, 1/l).
 */
export function randomSuffix(len = 6): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
