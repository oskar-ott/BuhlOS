import type { EmployeeRow } from "@/domains/employees/types";
import type { GearAsset } from "@/domains/gear/types";
import { deriveStatus } from "@/domains/gear/service";
import { calibrationFlag } from "@/domains/gear/format";
import { isAdminRole, isLeadingHandRole } from "@/lib/auth/roles";

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
 *   - Any live "on site now" figure stays OMITTED: there is no field-app
 *     heartbeat (employee.lastActiveAt is never populated today), so a live
 *     on-site count cannot be derived without fabricating it. The People row's
 *     "Licences to watch" tile is sourced from the same server-computed
 *     worst-status map the register already uses.
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

  // Lean-reset tile row (replica lines 424-428). All four figures are pure
  // projections over the register rows + the server-computed licence map:
  //   On the books   — live accounts (disabled workers are off the books)
  //   Set up on phone — finished self-setup (status flips to "active" on
  //                     invite acceptance), with pending invites as the hint
  //   Leading hands  — role-tier counts via the shared auth predicates
  //   Licences to watch — expired/due from the one shared licence engine
  const onBooks = rows.filter((r) => r.employee.status !== "disabled");
  const setUp = onBooks.filter((r) => r.employee.status === "active").length;
  const pending = onBooks.length - setUp;
  const leadingHands = onBooks.filter((r) => isLeadingHandRole(r.employee.role)).length;
  const admins = onBooks.filter((r) => isAdminRole(r.employee.role)).length;

  // Licence attention: expired beats due; only workers with an account
  // (userId) and on-file records contribute (others can't have a status yet).
  let licenceExpired = 0;
  let licenceDue = 0;
  for (const row of rows) {
    const flag = licenceFlagForRow(row, licenceStatusByUserId);
    if (flag === "expired") licenceExpired += 1;
    else if (flag === "expiring") licenceDue += 1;
  }
  const licenceAttention = licenceExpired + licenceDue;

  const tiles: StatTile[] = [
    {
      key: "books",
      label: "On the books",
      value: String(onBooks.length),
      hint: onBooks.length === 1 ? "active account" : "active accounts",
      tone: "neutral",
    },
    {
      key: "setup",
      label: "Set up on phone",
      value: String(setUp),
      hint:
        pending > 0
          ? `+${pending} invite${pending === 1 ? "" : "s"} pending`
          : "everyone set up",
      tone: "neutral",
    },
    {
      key: "leads",
      label: "Leading hands",
      value: String(leadingHands),
      hint: `+${admins} admin`,
      tone: "neutral",
    },
    {
      key: "licences",
      label: "Licences to watch",
      value: String(licenceAttention),
      hint:
        licenceAttention > 0
          ? `${licenceExpired} expired · ${licenceDue} due`
          : "all current",
      tone: licenceAttention > 0 ? "warning" : "neutral",
    },
  ];

  return { tiles };
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
