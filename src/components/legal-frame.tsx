import Link from "next/link";
import { BrandMark } from "./brand-mark";

/** Shared layout for public legal pages (privacy, terms, EULA). */
export function LegalFrame({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <BrandMark size={28} />
            <span className="font-heading text-sm tracking-[0.2em]">GROUNDWORKS</span>
          </Link>
          <nav className="ml-auto flex gap-4 text-xs text-muted-foreground">
            <Link href="/legal/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/legal/terms" className="hover:text-foreground">Terms</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="font-heading text-2xl tracking-wide">{title}</h1>
        <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Effective {effectiveDate}
        </p>
        <article className="mt-8 space-y-6 text-sm leading-6 text-foreground [&_h2]:font-heading [&_h2]:text-base [&_h2]:tracking-wide [&_h2]:mt-8 [&_h2]:mb-2 [&_h3]:font-semibold [&_h3]:text-sm [&_h3]:mt-4 [&_h3]:mb-1 [&_p]:text-foreground/90 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_ul>li]:text-foreground/90 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2">
          {children}
        </article>
        <footer className="mt-12 border-t border-border pt-6 text-xs text-muted-foreground">
          Floor Daddy, LLC d/b/a Groundworks. An Arizona limited liability company.
        </footer>
      </main>
    </div>
  );
}
