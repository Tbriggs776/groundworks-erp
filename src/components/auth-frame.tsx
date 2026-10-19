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
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-primary grid place-items-center">
              <span className="font-heading text-primary-foreground text-xl">G</span>
            </div>
            <div className="text-left">
              <div className="font-heading text-xl tracking-[0.2em]">GROUNDWORKS</div>
              <div className="text-[10px] tracking-[0.3em] text-muted-foreground uppercase">{tagline}</div>
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">{children}</div>
        {footer && <div className="text-[11px] text-center text-muted-foreground mt-6">{footer}</div>}
      </div>
    </div>
  );
}
