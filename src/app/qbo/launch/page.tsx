import Link from "next/link";
import { AuthFrame } from "@/components/auth-frame";
import { buttonVariants } from "@/components/ui/button";

/**
 * The URL registered as "Connect/Reconnect URL" in the Intuit app listing.
 * Intuit sends customers here from its app marketplace. Public, no auth.
 */
export const metadata = { title: "Connect QuickBooks · Groundworks" };

export default function QboLaunchPage() {
  return (
    <AuthFrame tagline="Connect QuickBooks" wide>
      <div className="space-y-5 text-sm">
        <p>
          Groundworks brings your QuickBooks Online company across in one go: the chart of accounts,
          customers, vendors, items, open estimates and purchase orders, bills, invoices, payments,
          and journal entries. Nothing is changed in QuickBooks.
        </p>

        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-2">
          <div className="font-medium">Already have a Groundworks account</div>
          <p className="text-muted-foreground text-xs">
            Sign in, open your workspace, and click <span className="text-foreground">Import from QuickBooks</span>.
            Workspace owners and admins can start an import.
          </p>
          <Link
            href="/auth/login?redirectTo=%2Fworkspace"
            className={buttonVariants({ size: "sm", className: "w-full" })}
          >
            Sign in and connect
          </Link>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-2">
          <div className="font-medium">New to Groundworks</div>
          <p className="text-muted-foreground text-xs">
            Create a free workspace, then import your QuickBooks company from the workspace page.
          </p>
          <Link
            href="/signup?redirectTo=%2Fworkspace"
            className={buttonVariants({ size: "sm", variant: "outline", className: "w-full" })}
          >
            Create your account
          </Link>
        </div>

        <div className="text-xs text-muted-foreground">
          Reconnecting a company whose QuickBooks link expired? Sign in, open that company, and go to{" "}
          <span className="text-foreground">Settings → QuickBooks → Reconnect</span>.
        </div>
      </div>
    </AuthFrame>
  );
}
