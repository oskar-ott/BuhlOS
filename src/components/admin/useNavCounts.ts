"use client";

import { useEffect, useState } from "react";
import { isOpenObservation } from "@/domains/observations/service";
import { isOpenRequest } from "@/domains/material-requests/service";
import type { ObservationStatus } from "@/domains/observations/types";
import type { MaterialRequestStatus } from "@/domains/material-requests/types";
import type { NavCountKey } from "./nav";

/**
 * Live counts for the admin sidebar badges (brief §1: "role-scoped nav with
 * live counts ... from real summary endpoints — never hardcoded").
 *
 * Design notes:
 *  - React Query is a dependency but NOT wired in this app (no provider), so
 *    this is a small module-cached hook rather than useQuery. The cache lives
 *    at module scope so the counts survive AdminShell remounts (the shell is
 *    rendered per-page, not in the persistent layout) and refetch at most once
 *    per STALE_MS — one fan-out per session, not one per navigation.
 *  - Every source is best-effort and INDEPENDENT: a failed/garbage payload
 *    yields NO key for that loop (the badge simply doesn't render), never a
 *    fabricated 0. Honest degradation over a false all-clear (CLAUDE.md P7).
 *  - The reducer is pure (deriveNavCounts) and unit-tested; the hook only adds
 *    fetching + caching around it.
 *
 * Counts wired here are the subset with a cheap, already-shipped source. Loops
 * without one (Command-centre criticals, QA exposure, quote pipeline, dayworks)
 * carry no countKey in ./nav and therefore no badge — by design, not omission.
 */
export type NavCounts = Partial<Record<NavCountKey, number>>;

/** Raw JSON from each summary endpoint (or null when the fetch failed). */
export interface NavCountPayloads {
  /** /api/admin-stats → jobs.active, users.byRole, snags.openTotal */
  stats: unknown;
  /** /api/time-entries?scope=approver&status=submitted → entries[] */
  hours: unknown;
  /** /api/observations → observations[] */
  observations: unknown;
  /** /api/material-requests → requests[] */
  materials: unknown;
  /** /api/expenses?status=submitted → expenses[] */
  expenses: unknown;
  /** /api/tags-expiring → tags[] + calibrations[] */
  gear: unknown;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pure mapping from raw endpoint payloads → sidebar counts. Mirrors the
 * Command Centre's own filters (isOpenObservation + requiresAction, isOpenRequest)
 * so the sidebar tally and the home queue cards never disagree.
 */
export function deriveNavCounts(p: NavCountPayloads): NavCounts {
  const counts: NavCounts = {};

  // admin-stats — three counts in one call.
  const stats = asObj(p.stats);
  if (stats) {
    const jobs = asObj(stats.jobs);
    const active = jobs ? asNum(jobs.active) : null;
    if (active != null) counts.jobs = active;

    const users = asObj(stats.users);
    const byRole = users ? asObj(users.byRole) : null;
    if (byRole) {
      // "Employees" = staff on the books (admins, leading hands, tradies) —
      // clients are not employees, so they're excluded from this tally.
      counts.people =
        (asNum(byRole.admin) ?? 0) +
        (asNum(byRole.leadingHand) ?? 0) +
        (asNum(byRole.tradie) ?? 0);
    }

    const snags = asObj(stats.snags);
    const open = snags ? asNum(snags.openTotal) : null;
    if (open != null) counts.defects = open;
  }

  // Hours pending approver action.
  const hours = asObj(p.hours);
  const hoursEntries = hours ? asArray(hours.entries) : null;
  if (hoursEntries) counts.hours = hoursEntries.length;

  // Observations open AND flagged as needing office action (the "From site"
  // queue) — same predicate the Command Centre uses.
  const obs = asObj(p.observations);
  const obsList = obs ? asArray(obs.observations) : null;
  if (obsList) {
    counts.obs = obsList.filter((o) => {
      const item = asObj(o);
      if (!item) return false;
      return (
        isOpenObservation(String(item.status) as ObservationStatus) &&
        item.requiresAction === true
      );
    }).length;
  }

  // Material requests still needing the office (requested / approved).
  const mats = asObj(p.materials);
  const matsList = mats ? asArray(mats.requests) : null;
  if (matsList) {
    counts.mats = matsList.filter((m) => {
      const item = asObj(m);
      if (!item) return false;
      return isOpenRequest(String(item.status) as MaterialRequestStatus);
    }).length;
  }

  // Expense claims awaiting review (endpoint already filtered to submitted).
  const exp = asObj(p.expenses);
  const expList = exp ? asArray(exp.expenses) : null;
  if (expList) counts.exp = expList.length;

  // Gear: test-and-tag entries + instrument calibrations expiring or expired
  // (tags-expiring returns only out-of-window items, never "ok").
  const gear = asObj(p.gear);
  if (gear) {
    const tags = asArray(gear.tags);
    const cals = asArray(gear.calibrations);
    if (tags || cals) counts.gear = (tags?.length ?? 0) + (cals?.length ?? 0);
  }

  return counts;
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Fan out to the cheap summary endpoints in parallel and reduce. */
export async function loadNavCounts(): Promise<NavCounts> {
  const [stats, hours, observations, materials, expenses, gear] = await Promise.all([
    fetchJson("/api/admin-stats"),
    fetchJson("/api/time-entries?scope=approver&status=submitted"),
    fetchJson("/api/observations"),
    fetchJson("/api/material-requests"),
    fetchJson("/api/expenses?status=submitted"),
    fetchJson("/api/tags-expiring"),
  ]);
  return deriveNavCounts({ stats, hours, observations, materials, expenses, gear });
}

const STALE_MS = 60_000;
let cache: { at: number; counts: NavCounts } | null = null;
let inflight: Promise<NavCounts> | null = null;

/** Test-only: drop the module cache so each case starts clean. */
export function __resetNavCountsCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Sidebar badge counts. Returns `{}` until the first fan-out resolves, then the
 * derived counts; seeds synchronously from the module cache on remount so
 * navigations don't flash empty badges.
 */
export function useNavCounts(): NavCounts {
  const [counts, setCounts] = useState<NavCounts>(() => (cache ? cache.counts : {}));

  useEffect(() => {
    let alive = true;
    if (cache && Date.now() - cache.at < STALE_MS) {
      setCounts(cache.counts);
      return;
    }
    if (!inflight) {
      inflight = loadNavCounts()
        .then((c) => {
          cache = { at: Date.now(), counts: c };
          return c;
        })
        .finally(() => {
          inflight = null;
        });
    }
    void inflight.then((c) => {
      if (alive) setCounts(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  return counts;
}
