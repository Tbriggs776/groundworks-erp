"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { BrandLockup, BrandMark } from "@/components/brand-mark";
import {
  BookOpen,
  Bot,
  Building2,
  ChevronDown,
  ChevronRight,
  FileBarChart,
  Landmark,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
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
      { label: "Inventory Adjustments", href: "/items/adjustments" },
      { label: "Sales Tax", href: "/sales-tax" },
    ],
  },
  {
    label: "Expenses",
    icon: Wallet,
    items: [
      { label: "Vendors", href: "/vendors" },
      { label: "Purchase Orders", href: "/ap/purchase-orders" },
      { label: "Bills", href: "/ap/bills" },
      { label: "Recurring Bills", href: "/ap/recurring" },
      { label: "Bill Payments", href: "/ap/payments" },
      { label: "Vendor Credits", href: "/ap/vendor-credits" },
      { label: "Vendor Refunds", href: "/ap/vendor-refunds" },
    ],
  },
  {
    label: "Banking",
    icon: Landmark,
    items: [
      { label: "Bank Accounts", href: "/banking", exact: true },
      { label: "Bank Feeds", href: "/banking/feeds" },
      { label: "For Review", href: "/banking/review" },
      { label: "Receipts", href: "/banking/receipts" },
      { label: "Transactions", href: "/banking/transactions" },
      { label: "Bank Rules", href: "/banking/rules" },
      { label: "Reconcile", href: "/banking/reconcile" },
      { label: "Print Checks", href: "/banking/checks" },
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
      { label: "Close Books", href: "/periods" },
      { label: "Exchange Rates", href: "/rates" },
      { label: "FX Revaluation", href: "/rates/revaluation" },
    ],
  },
  {
    label: "Reports",
    icon: FileBarChart,
    items: [
      { label: "Profit & Loss", href: "/reports/income-statement" },
      { label: "P&L by Month", href: "/reports/profit-and-loss-by-period" },
      { label: "P&L by Class", href: "/reports/profit-and-loss-by-class" },
      { label: "Budget vs Actual", href: "/reports/budget-vs-actual" },
      { label: "Cash Flow", href: "/reports/cash-flow" },
      { label: "Balance Sheet", href: "/reports/balance-sheet" },
      { label: "Sales by Customer", href: "/reports/sales-by-customer" },
      { label: "Sales by Item", href: "/reports/sales-by-item" },
      { label: "Inventory Valuation", href: "/reports/inventory-valuation" },
      { label: "Valuation Detail", href: "/reports/inventory-valuation-detail" },
      { label: "Stock Status", href: "/reports/inventory-stock-status" },
      { label: "Expenses by Vendor", href: "/reports/expenses-by-vendor" },
      { label: "AR Aging", href: "/reports/ar-aging" },
      { label: "Open Invoices", href: "/reports/open-invoices" },
      { label: "AP Aging", href: "/reports/ap-aging" },
      { label: "Unpaid Bills", href: "/reports/unpaid-bills" },
      { label: "1099s", href: "/reports/1099" },
      { label: "Trial Balance", href: "/reports/trial-balance" },
      { label: "GL Detail", href: "/reports/gl-detail" },
      { label: "Audit Trail", href: "/reports/audit-trail" },
      { label: "Changes After Close", href: "/reports/changes-after-close" },
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
      { label: "Inventory", href: "/settings/inventory" },
      { label: "QuickBooks Import", href: "/settings/quickbooks" },
      { label: "Email", href: "/settings/email" },
      { label: "Approval Thresholds", href: "/settings/approval-thresholds" },
      { label: "My Security", href: "/account/security" },
    ],
  },
];

const RAIL_KEY = "gw.sidebar.rail";
const EXPANDED_KEY = "gw.sidebar.expanded";
const STORAGE_EVENT = "gw:sidebar-storage";

/**
 * useSyncExternalStore subscription for same-tab localStorage writes. The
 * native "storage" event only fires in other tabs, so we dispatch a custom
 * event when we write.
 */
function subscribe(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(STORAGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(STORAGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
function emitChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_EVENT));
}

/** Boolean preference remembered across reloads (and across tabs). */
function usePersistentBool(key: string, defaultValue: boolean) {
  const read = () => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? defaultValue : raw === "1";
    } catch {
      return defaultValue;
    }
  };
  const value = useSyncExternalStore(subscribe, read, () => defaultValue);
  const set = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(value) : next;
    try {
      window.localStorage.setItem(key, resolved ? "1" : "0");
      emitChange();
    } catch {
      /* private mode */
    }
  };
  return [value, set] as const;
}

/**
 * Expanded-group map remembered across reloads. useSyncExternalStore
 * requires a stable snapshot reference per underlying value, so we cache
 * the parsed object keyed by the raw string from localStorage.
 */
let expandedRaw: string | null | undefined = undefined;
let expandedCache: Record<string, boolean> = {};
const emptyExpanded: Record<string, boolean> = {};

function readExpanded(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    if (raw === expandedRaw) return expandedCache;
    expandedRaw = raw;
    if (!raw) {
      expandedCache = {};
      return expandedCache;
    }
    const parsed = JSON.parse(raw);
    expandedCache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    return expandedCache;
  } catch {
    return expandedCache;
  }
}

function usePersistentExpanded() {
  const value = useSyncExternalStore(subscribe, readExpanded, () => emptyExpanded);
  const set = (
    updater:
      | Record<string, boolean>
      | ((prev: Record<string, boolean>) => Record<string, boolean>)
  ) => {
    const next = typeof updater === "function" ? updater(value) : updater;
    try {
      window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      emitChange();
    } catch {
      /* private mode */
    }
  };
  return [value, set] as const;
}

/** Brand lockup shared by the desktop sidebar and the mobile drawer. */
export function Brand({ rail }: { rail?: boolean }) {
  return (
    <Link href="/dashboard" aria-label="Groundworks home" className="block">
      {rail ? (
        <BrandMark size={34} tone="navy" />
      ) : (
        <BrandLockup tone="navy" tagline="Accounting · API" />
      )}
    </Link>
  );
}

/**
 * The nav list itself. Rendered inside the desktop sidebar and the mobile
 * drawer; `onNavigate` lets the drawer close itself after a tap. Groups
 * are collapsible: opening one closes any other opened by hand, and the
 * group holding the current page is always open regardless. State is kept
 * in localStorage so a bookkeeper's two favorite groups stay open across
 * reloads.
 */
export function SidebarNav({
  onNavigate,
  workspaceAdmin,
  rail = false,
  onExpandFromRail,
}: {
  onNavigate?: () => void;
  workspaceAdmin: boolean;
  rail?: boolean;
  onExpandFromRail?: () => void;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = usePersistentExpanded();

  const matches = (i: NavItem) =>
    pathname === i.href || (!i.exact && pathname.startsWith(`${i.href}/`));

  const activeRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [pathname]);

  const toggleGroup = (name: string, hasActive: boolean) => {
    if (rail && onExpandFromRail) {
      onExpandFromRail();
      setExpanded((prev) => ({ ...prev, [name]: true }));
      return;
    }
    setExpanded((prev) => {
      const isOpen = prev[name] ?? hasActive;
      return isOpen ? { ...prev, [name]: false } : { [name]: true };
    });
  };

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "flex-1 overflow-y-auto overscroll-contain py-3",
        rail ? "px-2 space-y-1" : "px-2 space-y-0.5"
      )}
    >
      {NAV.map((group) => {
        const items = group.items.filter((it) => workspaceAdmin || !it.adminOnly);
        if (items.length === 0) return null;
        const hasActive = items.some(matches);
        const isExpanded = expanded[group.label] ?? hasActive;
        const Icon = group.icon;

        return (
          <div key={group.label}>
            <button
              type="button"
              onClick={() => toggleGroup(group.label, hasActive)}
              title={rail ? group.label : undefined}
              aria-label={rail ? group.label : undefined}
              aria-expanded={rail ? undefined : isExpanded}
              className={cn(
                "gw-nav-item w-full flex items-center rounded-md transition-colors",
                rail
                  ? "relative justify-center px-0 py-2.5"
                  : "gap-2.5 px-3 py-2 md:py-2",
                hasActive
                  ? cn(
                      "text-white font-semibold bg-white/[0.06]",
                      rail &&
                        "before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-r-full before:bg-[var(--gw-gold)]"
                    )
                  : "text-sidebar-foreground hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0 text-[var(--gw-gold)]" />
              {!rail && (
                <>
                  <span className="flex-1 text-left text-[13.5px] font-medium tracking-wide">
                    {group.label}
                  </span>
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 opacity-70" />
                  ) : (
                    <ChevronRight className="h-4 w-4 opacity-60" />
                  )}
                </>
              )}
            </button>

            {isExpanded && !rail && (
              <div className="mb-1 ml-[22px] mt-0.5 space-y-0.5 border-l border-white/10 pl-2.5">
                {items.map((item, _, shown) => {
                  // A longer match in the group wins (Inventory Adjustments over Products & Services).
                  const subActive =
                    matches(item) &&
                    !shown.some((o) => o.href.length > item.href.length && matches(o));
                  return (
                    <Link
                      key={`${group.label}-${item.href}`}
                      ref={subActive ? activeRef : undefined}
                      href={item.soon ? "#" : item.href}
                      aria-disabled={item.soon}
                      aria-current={subActive ? "page" : undefined}
                      data-active={subActive ? "true" : undefined}
                      onClick={item.soon ? undefined : onNavigate}
                      className={cn(
                        "gw-nav-subitem relative flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors",
                        subActive
                          ? "bg-white/[0.08] text-white font-medium before:absolute before:-left-[11px] before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r-full before:bg-[var(--gw-gold)]"
                          : "text-sidebar-foreground/80 hover:bg-white/5 hover:text-white",
                        item.soon && "opacity-50 cursor-not-allowed hover:bg-transparent"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.soon && (
                        <span className="ml-auto text-[9px] tracking-widest px-1.5 py-[1px] rounded-full bg-white/10">
                          SOON
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** Desktop sidebar. Hidden below `md`; phones use the drawer in the topbar. */
export function Sidebar({ workspaceAdmin }: { workspaceAdmin: boolean }) {
  const [rail, setRail] = usePersistentBool(RAIL_KEY, false);

  return (
    <aside
      className={cn(
        "gw-sidebar hidden md:flex shrink-0 flex-col relative transition-[width] duration-200",
        rail ? "w-[72px]" : "w-64 lg:w-[17rem]"
      )}
    >
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[var(--gw-gold)] via-[var(--gw-gold-bright)] to-[var(--gw-gold)]" />
      <div
        className={cn(
          "flex items-center border-b border-sidebar-border",
          rail ? "justify-center py-4" : "justify-between pl-5 pr-3 py-4"
        )}
      >
        <Brand rail={rail} />
        {!rail && (
          <button
            type="button"
            onClick={() => setRail(true)}
            aria-label="Collapse navigation"
            title="Collapse menu"
            className="grid h-8 w-8 place-items-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            <PanelLeftClose className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
      {rail && (
        <div className="flex justify-center border-b border-sidebar-border py-2">
          <button
            type="button"
            onClick={() => setRail(false)}
            aria-label="Expand navigation"
            title="Expand menu"
            className="grid h-9 w-9 place-items-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            <PanelLeftOpen className="h-[18px] w-[18px]" />
          </button>
        </div>
      )}
      <SidebarNav
        workspaceAdmin={workspaceAdmin}
        rail={rail}
        onExpandFromRail={() => setRail(false)}
      />
      <div className="h-[env(safe-area-inset-bottom)]" />
    </aside>
  );
}
