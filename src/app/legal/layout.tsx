import Link from "next/link";
import { BrandLockup } from "@/components/brand-mark";

/**
 * Public chrome for legal pages (EULA, privacy). No auth required; linked
 * from the sign-up page and from the Intuit app directory listing.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <BrandLockup tone="paper" />
          </Link>
          <nav className="flex items-center gap-5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <Link href="/legal/eula" className="hover:text-foreground">EULA</Link>
            <Link href="/legal/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/auth/login" className="hover:text-foreground">Sign in</Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <article className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-relaxed text-foreground">
          {children}
        </article>
      </main>
      <footer className="border-t border-border mt-16">
        <div className="mx-auto max-w-3xl px-6 py-6 text-[11px] text-muted-foreground flex items-center justify-between">
          <span>&copy; {new Date().getFullYear()} Groundworks</span>
          <div className="flex gap-4">
            <Link href="/legal/eula" className="hover:text-foreground">End-user license agreement</Link>
            <Link href="/legal/privacy" className="hover:text-foreground">Privacy policy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
