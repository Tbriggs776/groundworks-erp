import Link from "next/link";
import { AuthFrame } from "@/components/auth-frame";
import { buttonVariants } from "@/components/ui/button";

/**
 * The URL registered as "Disconnect URL" in the Intuit app listing. Intuit
 * sends customers here after they disconnect Groundworks from the Apps
 * screen inside QuickBooks. Public, no auth.
 */
export const metadata = { title: "QuickBooks disconnected · Groundworks" };

export default function QboDisconnectedPage() {
  return (
    <AuthFrame tagline="QuickBooks disconnected" wide>
      <div className="space-y-5 text-sm">
        <p>
          Groundworks is no longer connected to your QuickBooks Online company. We&apos;ve stopped
          reading from it.
        </p>

        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1">
          <div className="font-medium">Your Groundworks books are safe</div>
          <p className="text-muted-foreground text-xs">
            The company and the history already imported stay in your workspace. Disconnecting only
            cuts the live link to QuickBooks.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-2">
          <div className="font-medium">Want to reconnect</div>
          <p className="text-muted-foreground text-xs">
            Sign in, open the company, and go to{" "}
            <span className="text-foreground">Settings → QuickBooks → Reconnect</span>.
          </p>
          <Link
            href="/auth/login?redirectTo=%2Fsettings%2Fquickbooks"
            className={buttonVariants({ size: "sm", className: "w-full" })}
          >
            Sign in to reconnect
          </Link>
        </div>
      </div>
    </AuthFrame>
  );
}
