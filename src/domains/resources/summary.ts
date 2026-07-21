import type { EmployeeRow } from "@/domains/employees/types";
import type { GearAsset } from "@/domains/gear/types";
import { deriveStatus } from "@/domains/gear/service";
import { calibrationFlag } from "@/domains/gear/format";

/**
 * Resources summary view-model (brief §7). Pure projections over the data the
 * People (/employees) and Gear (/gear) pages already load into a small row of
 * glanceable stat tiles — the prototype's KPI header (admin-resources.jsx).
 *
 * Pure + deterministic so it is unit-tested in isolation; the pages do the
 * (permission-gated) loading and render these tiles. No new source of truth,
 * no new fetch — every number is derived from the existing register rows or
 * the existing server-computed licence worst-status map.
 *
 * HONESTY (the project's #1 law — no fake UI, no invented numbers):
 *   - The prototype's "On site now" People tile is OMITTED: there is no Phil
 *     heartbeat (employee.lastActiveAt is never populated today), so a live
 *     on-site count cannot be derived without fabricating it. In its place the
 *     People row carries a real, spec-relevant tile — "Licences need
 *     attention" — sourced from the same server-computed worst-status map the
 *     register already uses.
 *   - The prototype's "Quarantined" Gear tile is relabelled "Damaged / missing"
 *     (the real condition states; there is no "quarantine" status in the model).
 *   - When a derivation has no real input the tile reads "—", never a fake 0.
 */

export type StatTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatTile {
  key: string;
  label: string;
  /** Pre-formatted display value, or "—" when the signal isn't available. */
  value: string;
  /** Sub-label under the value (context), e.g. "admin + payroll". */
  hint: string;
  /** Colour accent for the value; "neutral" is the calm default. */
  tone: StatTone;
}

/** Worst licence status per worker account id (server-computed, renewal-aware). */
export type LicenceWorst = Readonly<Record<string, "expired" | "expiring" | "ok">>;

export interface PeopleSummaryInput {
  rows: ReadonlyArray<EmployeeRow>;
  /** From /api/licences worstByUser — keyed by users.json userId. */
  licenceStatusByUserId: LicenceWorst;
}

export interface PeopleSummaryVM {
  /** Page sub-line: "12 employees · 3 pending setup". */
  subline: string;
  tiles: ReadonlyArray<StatTile>;
}

/** Worst licence flag for a row, or null if the worker has no account/no records. */
function licenceFlagForRow(
  row: EmployeeRow,
  worst: LicenceWorst,
): "expired" | "expiring" | null {
  const userId = row.employee.userId;
  if (!userId) return null;
  const status = worst[userId];
  return status === "expired" || status === "expiring" ? status : null;
}

export function buildPeopleSummary(input: PeopleSummaryInput): PeopleSummaryVM {
  const { rows, licenceStatusByUserId } = input;

  // appAccess is derived from role on every row (server-side), so the
  // office/field split is real, not a guess.
  const office = rows.filter(
    (r) => r.employee.appAccess === "buhlos" || r.employee.appAccess === "both",
  ).length;
  const field = rows.filter((r) => r.employee.appAccess === "phil").length;
  // "Pending setup" = anyone not yet active (disabled excluded — they're not
  // pending, they're off). Mirrors the register's "active" marker: a worker is
  // pending until employee.status flips to "active".
  const pending = rows.filter(
    (r) => r.employee.status !== "active" && r.employee.status !== "disabled",
  ).length;

  // Licence attention: expired beats expiring; only workers with an account
  // (userId) and on-file records contribute (others can't have a status yet).
  let licenceExpired = 0;
  let licenceExpiring = 0;
  for (const row of rows) {
    const flag = licenceFlagForRow(row, licenceStatusByUserId);
    if (flag === "expired") licenceExpired += 1;
    else if (flag === "expiring") licenceExpiring += 1;
  }
  const licenceAttention = licenceExpired + licenceExpiring;

  const tiles: StatTile[] = [
    {
      key: "office",
      label: "Office · BuhlOS",
      value: String(office),
      hint: "admin + payroll",
      tone: "neutral",
    },
    {
      key: "field",
      label: "Field",
      value: String(field),
      hint: "tradies + apprentices",
      tone: "neutral",
    },
    {
      key: "pending",
      label: "Pending setup",
      value: String(pending),
      hint: pending > 0 ? "invite not finished" : "everyone set up",
      tone: pending > 0 ? "warning" : "neutral",
    },
    {
      key: "licences",
      label: "Licences need attention",
      value: String(licenceAttention),
      hint:
        licenceExpired > 0
          ? `${licenceExpired} expired · ${licenceExpiring} expiring`
          : licenceAttention > 0
            ? "expiring soon"
            : "all current",
      tone:
        licenceExpired > 0 ? "danger" : licenceAttention > 0 ? "warning" : "success",
    },
  ];

  const subline = `${rows.length} ${
    rows.length === 1 ? "employee" : "employees"
  } · ${pending} pending setup`;

  return { subline, tiles };
}

export interface GearSummaryInput {
  assets: ReadonlyArray<GearAsset>;
  /** Calibration window in days (matches /api/tags-expiring default = 14). */
  calibrationWithinDays?: number;
  /** Injected "today" (YYYY-MM-DD) so the projection stays deterministic. */
  today: string;
}

export interface GearSummaryVM {
  subline: string;
  tiles: ReadonlyArray<StatTile>;
}

export function buildGearSummary(input: GearSummaryInput): GearSummaryVM {
  const { assets, today } = input;
  const withinDays = input.calibrationWithinDays ?? 14;

  // Live assets only for the headline counts — retired gear isn't "tracked"
  // in the active sense the tiles describe.
  const live = assets.filter((a) => deriveStatus(a) !== "retired");

  const inUse = live.filter((a) => deriveStatus(a) === "assigned").length;
  const available = live.filter((a) => deriveStatus(a) === "available").length;
  const damagedMissing = live.filter((a) => {
    const s = deriveStatus(a);
    return s === "damaged" || s === "missing";
  }).length;

  // Calibration due soon: reuse the SAME calibrationFlag the gear format/register
  // and the cross-job /api/tags-expiring board use — never re-derived here.
  const calDueSoon = live.filter(
    (a) => calibrationFlag(a, today, withinDays) !== null,
  ).length;

  // "Needs attention" = anything not green: damaged/missing OR a calibration
  // flagged. A single asset can be both; count distinct assets.
  const needsAttention = live.filter((a) => {
    const s = deriveStatus(a);
    if (s === "damaged" || s === "missing") return true;
    return calibrationFlag(a, today, withinDays) !== null;
  }).length;

  const tiles: StatTile[] = [
    {
      key: "inuse",
      label: "In use",
      value: String(inUse),
      hint: "issued to crew",
      tone: "neutral",
    },
    {
      key: "damaged",
      label: "Damaged / missing",
      value: String(damagedMissing),
      hint: damagedMissing > 0 ? "needs action" : "all sound",
      tone: damagedMissing > 0 ? "danger" : "neutral",
    },
    {
      key: "cal",
      label: "Calibration due soon",
      value: String(calDueSoon),
      hint: calDueSoon > 0 ? `within ${withinDays} days` : "test gear current",
      tone: calDueSoon > 0 ? "warning" : "neutral",
    },
    {
      key: "available",
      label: "Available",
      value: String(available),
      hint: "in store",
      tone: "success",
    },
  ];

  const subline = `${live.length} tracked · ${needsAttention} need attention`;

  return { subline, tiles };
}
