/**
 * Default contract types seeded for new orgs. All flagged `isSystem = true`
 * so they can be renamed / deactivated but not deleted. Admins are free to
 * add more via /settings/contract-types.
 */

export const DEFAULT_CONTRACT_TYPES = [
  {
    code: "LUMP_SUM",
    name: "Lump Sum",
    description: "Fixed contract amount; contractor absorbs cost variances.",
    sortOrder: 10,
  },
  {
    code: "T_AND_M",
    name: "Time & Materials",
    description: "Bill actual labor hours + materials + markup.",
    sortOrder: 20,
  },
  {
    code: "COST_PLUS",
    name: "Cost Plus",
    description: "Reimbursable costs plus a fixed or percentage fee.",
    sortOrder: 30,
  },
  {
    code: "UNIT_PRICE",
    name: "Unit Price",
    description: "Fixed price per unit of work (per ton, per SF, etc.).",
    sortOrder: 40,
  },
  {
    code: "GUARANTEED_MAX",
    name: "Guaranteed Maximum Price (GMP)",
    description:
      "Cost-plus contract with a ceiling — contractor eats overages, shares savings.",
    sortOrder: 50,
  },
] as const;
