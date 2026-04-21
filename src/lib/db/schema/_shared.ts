import { pgEnum, timestamp } from "drizzle-orm/pg-core";

/**
 * Standard timestamps. Spread into every table.
 *   `deletedAt` enables soft-delete. Queries should filter `WHERE deleted_at IS NULL`
 *   unless they explicitly need tombstoned rows (audit / compliance).
 */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

/**
 * Organization-level role. Drives authorization throughout the app.
 *   owner       — full control, billing, can delete the org
 *   admin       — full app access, no billing
 *   accountant  — GL / AP / AR / close
 *   pm          — project/job management, no posting to GL
 *   foreman     — field ops (time, daily reports), read-only on financials
 *   viewer      — read-only
 * Roles are intentionally coarse at this layer; fine-grained permissions live
 * in a separate `permissions` layer later (not needed for Tier 0).
 */
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "accountant",
  "pm",
  "foreman",
  "viewer",
]);
