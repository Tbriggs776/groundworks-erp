/**
 * The Groundworks mark: a double-ruled circle, a gold star above, and a
 * classical "G". Drawn in the house palette (navy and gold) so it reads on
 * ivory paper (`tone="paper"`) or on the navy sidebar (`tone="navy"`).
 */
export function BrandMark({
  size = 32,
  tone = "paper",
  className,
}: {
  size?: number;
  tone?: "paper" | "navy";
  className?: string;
}) {
  const outer = tone === "paper" ? "var(--gw-navy)" : "var(--gw-gold)";
  const letter = tone === "paper" ? "var(--gw-navy)" : "#FFFFFF";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label="Groundworks"
      className={className}
    >
      <circle cx="20" cy="20" r="18.6" fill="none" stroke={outer} strokeWidth="1.6" />
      <circle cx="20" cy="20" r="15.6" fill="none" stroke="var(--gw-gold)" strokeWidth="0.9" opacity={tone === "paper" ? 1 : 0.55} />
      <polygon
        points="20.00,6.90 20.79,9.11 23.14,9.18 21.28,10.62 21.94,12.87 20.00,11.55 18.06,12.87 18.72,10.62 16.86,9.18 19.21,9.11"
        fill="var(--gw-gold)"
      />
      <text
        x="20"
        y="28.4"
        textAnchor="middle"
        fontSize="14.5"
        fontWeight="700"
        fill={letter}
        style={{ fontFamily: "var(--font-cinzel), Georgia, serif" }}
      >
        G
      </text>
    </svg>
  );
}

/** Mark + wordmark. */
export function BrandLockup({ tone = "paper", tagline }: { tone?: "paper" | "navy"; tagline?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark size={34} tone={tone} />
      <div className="leading-none">
        <div
          className={`font-heading text-[15px] tracking-[0.14em] ${tone === "navy" ? "text-white" : "text-[var(--gw-navy)]"}`}
        >
          GROUNDWORKS
        </div>
        {tagline && (
          <div className={`mt-1 text-[9px] font-medium uppercase tracking-[0.28em] ${tone === "navy" ? "text-[var(--gw-gold)]" : "text-[var(--gw-gold-deep)]"}`}>
            {tagline}
          </div>
        )}
      </div>
    </div>
  );
}
