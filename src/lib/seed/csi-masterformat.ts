import type { NewCostCode, CostCode } from "@/lib/db/schema";

/**
 * CSI MasterFormat 2018 — top-level divisions. Construction industry
 * standard for cost code structure. Seed is opt-in during onboarding;
 * tenants may add subsections (e.g., "03 30 00 Cast-in-Place Concrete")
 * as children under each division.
 *
 * Ranges deliberately skipped where MasterFormat reserves spots for
 * future expansion (15–19, 20, 29–30, 36–39, 47, 49).
 */

type DivisionSeed = Pick<
  NewCostCode,
  "code" | "name" | "description" | "costType" | "sortOrder"
>;

export const CSI_DIVISIONS: DivisionSeed[] = [
  // General
  { code: "00", name: "Procurement & Contracting", description: "Bidding, contracts, conditions", costType: "overhead", sortOrder: 0 },
  { code: "01", name: "General Requirements", description: "General conditions, bonds, permits, supervision", costType: "overhead", sortOrder: 1 },

  // Facility construction subgroup
  { code: "02", name: "Existing Conditions", description: "Demolition, site remediation, selective demolition", costType: "subcontractor", sortOrder: 2 },
  { code: "03", name: "Concrete", description: "Cast-in-place, precast, concrete finishing", costType: "subcontractor", sortOrder: 3 },
  { code: "04", name: "Masonry", description: "CMU, brick, stone", costType: "subcontractor", sortOrder: 4 },
  { code: "05", name: "Metals", description: "Structural steel, metal fabrications, decking", costType: "subcontractor", sortOrder: 5 },
  { code: "06", name: "Wood, Plastics & Composites", description: "Rough carpentry, finish carpentry, millwork", costType: "subcontractor", sortOrder: 6 },
  { code: "07", name: "Thermal & Moisture Protection", description: "Insulation, waterproofing, roofing, siding", costType: "subcontractor", sortOrder: 7 },
  { code: "08", name: "Openings", description: "Doors, windows, storefronts, hardware", costType: "subcontractor", sortOrder: 8 },
  { code: "09", name: "Finishes", description: "Flooring, drywall, painting, acoustical", costType: "subcontractor", sortOrder: 9 },
  { code: "10", name: "Specialties", description: "Toilet accessories, signage, lockers", costType: "material", sortOrder: 10 },
  { code: "11", name: "Equipment", description: "Commercial / institutional equipment", costType: "material", sortOrder: 11 },
  { code: "12", name: "Furnishings", description: "Furniture, window treatments, art", costType: "material", sortOrder: 12 },
  { code: "13", name: "Special Construction", description: "Pre-engineered, integrated construction", costType: "subcontractor", sortOrder: 13 },
  { code: "14", name: "Conveying Equipment", description: "Elevators, escalators, lifts", costType: "subcontractor", sortOrder: 14 },

  // Facility services subgroup
  { code: "21", name: "Fire Suppression", description: "Sprinklers, standpipes, fire protection", costType: "subcontractor", sortOrder: 21 },
  { code: "22", name: "Plumbing", description: "Piping, fixtures, plumbing equipment", costType: "subcontractor", sortOrder: 22 },
  { code: "23", name: "HVAC", description: "Heating, ventilation, air conditioning", costType: "subcontractor", sortOrder: 23 },
  { code: "25", name: "Integrated Automation", description: "Building automation / controls", costType: "subcontractor", sortOrder: 25 },
  { code: "26", name: "Electrical", description: "Power, lighting, grounding", costType: "subcontractor", sortOrder: 26 },
  { code: "27", name: "Communications", description: "Structured cabling, data, voice", costType: "subcontractor", sortOrder: 27 },
  { code: "28", name: "Electronic Safety & Security", description: "Access control, CCTV, alarms", costType: "subcontractor", sortOrder: 28 },

  // Site & infrastructure subgroup
  { code: "31", name: "Earthwork", description: "Excavation, grading, site earthwork", costType: "subcontractor", sortOrder: 31 },
  { code: "32", name: "Exterior Improvements", description: "Paving, landscaping, fences", costType: "subcontractor", sortOrder: 32 },
  { code: "33", name: "Utilities", description: "Water, sanitary, storm, gas, electrical utilities", costType: "subcontractor", sortOrder: 33 },
  { code: "34", name: "Transportation", description: "Roadways, bridges, tunnels, rail", costType: "subcontractor", sortOrder: 34 },
  { code: "35", name: "Waterway & Marine", description: "Marine structures, dredging", costType: "subcontractor", sortOrder: 35 },

  // Process subgroup
  { code: "40", name: "Process Integration", description: "Industrial process integration", costType: "subcontractor", sortOrder: 40 },
  { code: "41", name: "Material Processing & Handling Equipment", description: "Conveying, storage, feeders", costType: "material", sortOrder: 41 },
  { code: "42", name: "Process Heating, Cooling, Drying", description: "Process HCD equipment", costType: "material", sortOrder: 42 },
  { code: "43", name: "Process Gas & Liquid Handling", description: "Process piping, pumps, tanks", costType: "material", sortOrder: 43 },
  { code: "44", name: "Pollution & Waste Control", description: "Air / water / soil pollution control", costType: "subcontractor", sortOrder: 44 },
  { code: "45", name: "Industry-Specific Manufacturing", description: "Manufacturing-line equipment", costType: "material", sortOrder: 45 },
  { code: "46", name: "Water & Wastewater", description: "Water / wastewater treatment", costType: "subcontractor", sortOrder: 46 },
  { code: "48", name: "Electrical Power Generation", description: "Onsite power generation", costType: "subcontractor", sortOrder: 48 },
];

/**
 * Returns the seed shape (minus organization_id + timestamps) for callers.
 * Used both by onboarding and by the /cost-codes UI's "Seed CSI" button.
 */
export function csiSeedRows(): DivisionSeed[] {
  return CSI_DIVISIONS;
}

// Satisfy TS unused-import check in some tooling paths
void null as unknown as CostCode;
