"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BrandLockup } from "@/components/brand-mark";
import {
  BookOpen,
  Bot,
  Building2,
  FileBarChart,
  Landmark,
  LayoutDashboard,
  Receipt,
  Settings,
  Wallet,
} from "lucide-react";

type NavItem = {
  label: string;
  href: string;
  soon?: boolean;
  /** Highlight only on this exact path (not its children). */
  exact?: boolean;
  /** Workspace owners / admins only. */
  adminOnly?: boolean;
};

type NavGroup = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
};

/**
 * Navigation, grouped the way QuickBooks users already think about their
 * books. Items flagged `soon` render with a pill until the route ships.
 */
const NAV: NavGroup[] = [
  {
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "All Companies", href: "/clients" },
    ],
  },
  {
    label: "Sales",
    icon: Receipt,
    items: [
      { label: "Customers", href: "/customers" },
      { label: "Estimates", href: "/ar/estimates" },
      { label: "Invoices", href: "/ar/invoices" },
      { label: "Recurring Invoices", href: "/ar/recurring" },
      { label: "Sales Receipts", href: "/ar/sales-receipts" },
      { label: "Payments Received", href: "/ar/payments" },
      { label: "Credit Memos", href: "/ar/credit-memos" },
      { label: "Refunds", href: "/ar/refunds" },
      { label: "Statements", href: "/ar/statements" },
      { label: "Products & Services", href: "/items" },
      { label: "Sales Tax", href: "/sales-tax" },
    ],
  },
  {
    label: "Expenses",
    icon: Wallet,
    items: [
      { label: "Vendors", href: "/vendors" },
      { label: "Bills", href: "/ap/bills" },
      { label: "Bill Payments", href: "/ap/payments" },
    ],
  },
  {
    label: "Banking",
    icon: Landmark,
    items: [
      { label: "Bank Accounts", href: "/banking", exact: true },
      { label: "For Review", href: "/banking/review" },
      { label: "Transactions", href: "/banking/transactions" },
      { label: "Bank Rules", href: "/banking/rules" },
      { label: "Reconcile", href: "/banking/reconcile" },
    ],
  },
  {
    label: "Accounting",
    icon: BookOpen,
    items: [
      { label: "Chart of Accounts", href: "/accounts" },
      { label: "Journal Entries", href: "/gl" },
      { label: "Recurring", href: "/recurring" },
      { label: "Allocations", href: "/allocations" },
      { label: "Budgets", href: "/budgets" },
      { label: "Classes & Locations", href: "/dimensions" },
      { label: "Period Close", href: "/periods" },
      { label: "Exchange Rates", href: "/rates" },
      { label: "FX Revaluation", href: "/rates/revaluation" },
    ],
  },
  {
    label: "Reports",
    icon: FileBarChart,
    items: [
      { label: "Profit & Loss", href: "/reports/income-statement" },
      { label: "Balance Sheet", href: "/reports/balance-sheet" },
      { label: "AR Aging", href: "/reports/ar-aging" },
      { label: "AP Aging", href: "/reports/ap-aging" },
      { label: "Trial Balance", href: "/reports/trial-balance" },
      { label: "GL Detail", href: "/reports/gl-detail" },
    ],
  },
  {
    label: "Agents & API",
    icon: Bot,
    items: [
      { label: "Review Queue", href: "/review" },
      { label: "Agents", href: "/settings/agents" },
      { label: "API Keys", href: "/settings/api-keys" },
      { label: "Activity", href: "/activity" },
    ],
  },
  {
    label: "Workspace",
    icon: Building2,
    items: [
      { label: "Companies", href: "/workspace", exact: true },
      { label: "People", href: "/workspace/people" },
      { label: "Security Policy", href: "/workspace/security" },
      { label: "Access Review", href: "/workspace/access-review", adminOnly: true },
      { label: "Audit Log", href: "/workspace/audit", adminOnly: true },
    ],
  },
  {
    label: "Settings",
    icon: Settings,
    items: [
      { label: "Company Profile", href: "/settings/company" },
      { label: "Sales Settings", href: "/settings/sales" },
      { label: "Approval Thresholds", href: "/settings/approval-thresholds" },
      { label: "My Security", href: "/account/security" },
    ],
  },
];

/** Brand lockup shared by the desktop sidebar and the mobile drawer. */
export function Brand() {
  return (
    <Link href="/dashboard" className="block">
      <BrandLockup tone="navy" tagline="Accounting · API" />
    </Link>
  );
}

/**
 * The nav list itself. Rendered inside the desktop sidebar and the mobile
 * drawer; `onNavigate` lets the drawer close itself after a tap.
 */
export function SidebarNav({
  onNavigate,
  workspaceAdmin,
}: {
  onNavigate?: () => void;
  workspaceAdmin: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 overflow-y-auto py-2 overscroll-contain">
      {NAV.map((group) => (
        <div key={group.label} className="mb-1">
          <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
            <group.icon className="h-3.5 w-3.5 text-[var(--gw-gold)]" />
            <span className="text-[10px] font-semibold tracking-[0.2em] uppercase text-sidebar-foreground/60">
              {group.label}
            </span>
          </div>
          {group.items.filter((item) => workspaceAdmin || !item.adminOnly).map((item) => {
            const active =
              pathname === item.href || (!item.exact && pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={`${group.label}-${item.href}`}
                href={item.soon ? "#" : item.href}
                aria-disabled={item.soon}
                aria-current={active ? "page" : undefined}
                onClick={item.soon ? undefined : onNavigate}
                className={cn(
                  "mx-2 flex items-center gap-2 rounded-md px-3 py-2.5 md:py-1.5 text-sm md:text-[13px] transition-colors",
                  active
                    ? "bg-sidebar-accent text-white font-medium shadow-[inset_2px_0_0_var(--gw-gold)]"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-white",
                  item.soon && "opacity-50 cursor-not-allowed hover:bg-transparent"
                )}
              >
                <span className="truncate">{item.label}</span>
                {item.soon && (
                  <span className="ml-auto text-[9px] tracking-widest px-1.5 py-[1px] rounded-full bg-white/10 text-sidebar-foreground">
                    SOON
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Desktop sidebar. Hidden below `md`; phones use the drawer in the topbar. */
export function Sidebar({ workspaceAdmin }: { workspaceAdmin: boolean }) {
  return (
    <aside className="hidden md:flex w-60 shrink-0 bg-sidebar flex-col relative">
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[var(--gw-gold)] via-[var(--gw-gold-bright)] to-[var(--gw-gold)]" />
      <div className="px-4 py-4 border-b border-sidebar-border">
        <Brand />
      </div>
      <SidebarNav workspaceAdmin={workspaceAdmin} />
    </aside>
  );
}
