"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  Bot,
  FileBarChart,
  LayoutDashboard,
  Receipt,
  Settings,
  Wallet,
} from "lucide-react";

type NavItem = {
  label: string;
  href: string;
  soon?: boolean;
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
    items: [{ label: "Dashboard", href: "/dashboard" }],
  },
  {
    label: "Sales",
    icon: Receipt,
    items: [
      { label: "Customers", href: "/customers" },
      { label: "Invoices", href: "/ar/invoices" },
      { label: "Payments Received", href: "/ar/payments" },
      { label: "Products & Services", href: "/items" },
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
    label: "Settings",
    icon: Settings,
    items: [
      { label: "Team", href: "/settings/team" },
      { label: "Approval Thresholds", href: "/settings/approval-thresholds" },
    ],
  },
];

/** Brand lockup shared by the desktop sidebar and the mobile drawer. */
export function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5">
      <div className="h-8 w-8 rounded-md bg-gradient-to-br from-[var(--gw-gold-bright)] to-[var(--gw-gold)] grid place-items-center shadow-[0_0_12px_-2px_var(--gw-gold)]">
        <span className="font-heading text-primary-foreground text-lg">G</span>
      </div>
      <div>
        <div className="font-heading text-[15px] tracking-[0.2em] text-foreground">
          GROUNDWORKS
        </div>
        <div className="text-[9px] tracking-[0.3em] text-muted-foreground uppercase mt-0.5">
          Accounting · API
        </div>
      </div>
    </Link>
  );
}

/**
 * The nav list itself. Rendered inside the desktop sidebar and the mobile
 * drawer; `onNavigate` lets the drawer close itself after a tap.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 overflow-y-auto py-2 overscroll-contain">
      {NAV.map((group) => (
        <div key={group.label} className="mb-1">
          <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
            <group.icon className="h-3.5 w-3.5 text-[var(--gw-gold)]/70" />
            <span className="text-[10px] font-semibold tracking-[0.2em] uppercase text-muted-foreground">
              {group.label}
            </span>
          </div>
          {group.items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={`${group.label}-${item.href}`}
                href={item.soon ? "#" : item.href}
                aria-disabled={item.soon}
                aria-current={active ? "page" : undefined}
                onClick={item.soon ? undefined : onNavigate}
                className={cn(
                  "mx-2 flex items-center gap-2 rounded-md px-3 py-2.5 md:py-1.5 text-sm md:text-xs transition-colors",
                  active
                    ? "bg-primary/15 text-primary font-semibold shadow-[inset_2px_0_0_var(--gw-gold)]"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  item.soon && "opacity-50 cursor-not-allowed hover:bg-transparent"
                )}
              >
                <span className="truncate">{item.label}</span>
                {item.soon && (
                  <span className="ml-auto text-[9px] tracking-widest px-1.5 py-[1px] rounded-full bg-background text-muted-foreground">
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
export function Sidebar() {
  return (
    <aside className="hidden md:flex w-60 shrink-0 border-r border-border bg-sidebar flex-col relative">
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[var(--gw-gold)] via-[var(--gw-gold-bright)] to-[var(--gw-gold)]" />
      <div className="px-4 py-4 border-b border-border">
        <Brand />
      </div>
      <SidebarNav />
    </aside>
  );
}
