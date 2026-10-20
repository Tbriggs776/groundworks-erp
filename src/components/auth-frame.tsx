import { BrandMark } from "./brand-mark";

/** Brand lockup + card used by the sign-in, sign-up, and onboarding pages. */
export function AuthFrame({
  tagline,
  children,
  footer,
  wide,
}: {
  tagline: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className={`w-full ${wide ? "max-w-md" : "max-w-sm"}`}>
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark size={56} />
          <div className="font-heading text-xl tracking-[0.18em] mt-3">GROUNDWORKS</div>
          <div className="mt-2 flex items-center gap-2 text-[10px] font-medium tracking-[0.28em] uppercase text-[var(--gw-gold-deep)]">
            <span className="h-px w-6 bg-[var(--gw-gold)]" />
            {tagline}
            <span className="h-px w-6 bg-[var(--gw-gold)]" />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_3px_rgb(27_42_78/0.06),0_8px_24px_-12px_rgb(27_42_78/0.12)]">
          {children}
        </div>
        {footer && <div className="text-[11px] text-center text-muted-foreground mt-6">{footer}</div>}
      </div>
    </div>
  );
}
