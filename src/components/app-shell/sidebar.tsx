"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Banknote,
  Building2,
  FileBarChart,
  Hammer,
  HardHat,
  LineChart,
  Receipt,
  Settings,
  Truck,
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
 * The eight mega-modules. Most routes don't exist yet — items render with a
 * "soon" pill. As each module is built the pill is removed.
 */
const NAV: NavGroup[] = [
  {
    label: "Financials",
    icon: Banknote,
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Chart of Accounts", href: "/accounts" },
      { label: "Dimensions", href: "/dimensions" },
      { label: "General Ledger", href: "/gl" },
      { label: "Recurring", href: "/recurring" },
      { label: "Allocations", href: "/allocations" },
      { label: "Budgets", href: "/budgets" },
      { label: "Period Close", href: "/periods" },
      { label: "Exchange Rates", href: "/rates" },
      { label: "FX Revaluation", href: "/rates/revaluation" },
      { label: "Audit Trail", href: "/audit", soon: true },
    ],
  },
  {
    label: "Reports",
    icon: FileBarChart,
    items: [
      { label: "Trial Balance", href: "/reports/trial-balance" },
      { label: "Balance Sheet", href: "/reports/balance-sheet" },
      { label: "Income Statement", href: "/reports/income-statement" },
      { label: "GL Detail", href: "/reports/gl-detail" },
    ],
  },
  {
    label: "Projects",
    icon: HardHat,
    items: [
      { label: "Jobs", href: "/jobs" },
      { label: "Cost Codes", href: "/cost-codes" },
      { label: "Job Cost", href: "/jobs/cost", soon: true },
      { label: "Change Orders", href: "/jobs/change-orders", soon: true },
      { label: "Commitments", href: "/commitments", soon: true },
    ],
  },
  {
    label: "Billing",
    icon: Receipt,
    items: [
      { label: "Customers", href: "/customers" },
      { label: "AR", href: "/ar", soon: true },
      { label: "AIA / SOV", href: "/ar/aia", soon: true },
      { label: "Retainage", href: "/ar/retainage", soon: true },
    ],
  },
  {
    label: "Procurement",
    icon: Wallet,
    items: [
      { label: "Vendors", href: "/vendors" },
      { label: "AP", href: "/ap", soon: true },
      { label: "POs", href: "/po", soon: true },
      { label: "Subcontractors", href: "/subs", soon: true },
    ],
  },
  {
    label: "People",
    icon: Building2,
    items: [
      { label: "Employees", href: "/employees" },
      { label: "Payroll", href: "/payroll", soon: true },
      { label: "Time & Expense", href: "/time", soon: true },
    ],
  },
  {
    label: "Field Ops",
    icon: Truck,
    items: [
      { label: "Dispatch", href: "/dispatch", soon: true },
      { label: "Equipment", href: "/equipment", soon: true },
      { label: "Documents", href: "/documents", soon: true },
    ],
  },
  {
    label: "Finance & Risk",
    icon: LineChart,
    items: [
      { label: "Cash Flow", href: "/cashflow", soon: true },
      { label: "Fixed Assets", href: "/assets", soon: true },
      { label: "Surety", href: "/surety", soon: true },
    ],
  },
  {
    label: "Growth",
    icon: Hammer,
    items: [
      { label: "CRM", href: "/crm", soon: true },
      { label: "Estimating", href: "/estimating", soon: true },
      { label: "BI", href: "/bi", soon: true },
    ],
  },
  {
    label: "Settings",
    icon: Settings,
    items: [
      { label: "Contract Types", href: "/settings/contract-types" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-sidebar flex flex-col relative">
      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-[var(--gw-gold)] via-[var(--gw-gold-bright)] to-[var(--gw-gold)]" />

      <div className="px-4 py-4 border-b border-border">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-md bg-primary grid place-items-center">
            <span className="font-heading text-primary-foreground text-lg">
              G
            </span>
          </div>
          <div>
            <div className="font-heading text-[15px] tracking-[0.2em] text-foreground">
              GROUNDWORKS
            </div>
            <div className="text-[8px] tracking-[0.3em] text-muted-foreground uppercase mt-0.5">
              ERP · Platform
            </div>
          </div>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
              <group.icon className="h-3 w-3 text-muted-foreground" />
              <span className="text-[8px] font-bold tracking-[0.22em] uppercase text-muted-foreground">
                {group.label}
              </span>
            </div>
            {group.items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.soon ? "#" : item.href}
                  aria-disabled={item.soon}
                  className={cn(
                    "flex items-center gap-2 px-4 py-1.5 text-xs border-l-2 transition-colors",
                    active
                      ? "bg-primary/10 text-primary border-primary font-semibold"
                      : "text-muted-foreground border-transparent hover:bg-accent hover:text-accent-foreground",
                    item.soon && "opacity-60 cursor-not-allowed"
                  )}
                >
                  <span className="h-1 w-1 rounded-full bg-current opacity-50" />
                  <span>{item.label}</span>
                  {item.soon && (
                    <span className="ml-auto text-[8px] tracking-widest px-1.5 py-[1px] rounded-full bg-muted text-muted-foreground">
                      SOON
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
