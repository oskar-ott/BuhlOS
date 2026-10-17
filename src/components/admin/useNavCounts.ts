"use client";

import { useEffect, useState } from "react";
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
 *  - Seeds (2026-10-15, shorter-paths audit D1). The module cache dies on every
 *    full page load, so each load re-fired all three sources — including the
 *    hours queue, whose server walk lists and fetches every day-file in the
 *    store (~485 files, ~3.5 s of function time in prod) for one badge number.
 *    An office page that has ALREADY computed a count for its own content
 *    (the command centre's pending hours, the approvals queue) passes it in as
 *    a seed through AdminShell; the hook then fetches only the sources the
 *    seed does not answer. A seed carries the page's own honesty: a page whose
 *    source failed passes nothing for that key, so no badge — never a 0.
 *    The planner (applySeed / sourcesToFetch / mergeFetched) is pure and
 *    unit-tested; the hook is the thin React wrapper around it.
 *
 * Counts wired here are the subset with a cheap, already-shipped source. Loops
 * without one (Command-centre criticals) carry no countKey in ./nav and
 * therefore no badge — by design, not omission.
 */
export type NavCounts = Partial<Record<NavCountKey, number>>;

/** Raw JSON from each summary endpoint (or null when the fetch failed). */
export interface NavCountPayloads {
  /** /api/admin-stats → jobs.active, users.byRole */
  stats: unknown;
  /** /api/time-entries?scope=approver&status=submitted → entries[] */
  hours: unknown;
  /** /api/tags-expiring → tags[] + calibrations[] */
  gear: unknown;
}

export type NavSource = keyof NavCountPayloads;

export const NAV_SOURCES: ReadonlyArray<NavSource> = ["stats", "hours", "gear"];

const SOURCE_URL: Record<NavSource, string> = {
  stats: "/api/admin-stats",
  hours: "/api/time-entries?scope=approver&status=submitted",
  gear: "/api/tags-expiring",
};

/** Which badge keys each source answers — a seed covers a source only when it
 *  carries EVERY one of them (admin-stats answers both jobs and people). */
export const SOURCE_KEYS: Record<NavSource, ReadonlyArray<NavCountKey>> = {
  stats: ["jobs", "people"],
  hours: ["hours"],
  gear: ["gear"],
};

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
 * Pure mapping from raw endpoint payloads → sidebar counts, so the sidebar
 * tally and the home queue cards never disagree.
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
  }

  // Hours pending approver action.
  const hours = asObj(p.hours);
  const hoursEntries = hours ? asArray(hours.entries) : null;
  if (hoursEntries) counts.hours = hoursEntries.length;

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

// One in-flight request per source, shared by every mounted nav (the desktop
// pills and the mobile tab bar mount together on every office page).
const inflight: Partial<Record<NavSource, Promise<unknown>>> = {};

function fetchSource(source: NavSource): Promise<unknown> {
  let p = inflight[source];
  if (!p) {
    p = fetchJson(SOURCE_URL[source]).finally(() => {
      delete inflight[source];
    });
    inflight[source] = p;
  }
  return p;
}

/** Fan out to the given summary endpoints in parallel and reduce. Sources not
 *  asked for are left null, so their keys are simply absent from the result. */
export async function loadNavCounts(
  sources: ReadonlyArray<NavSource> = NAV_SOURCES
): Promise<NavCounts> {
  const payloads: NavCountPayloads = { stats: null, hours: null, gear: null };
  await Promise.all(
    sources.map(async (s) => {
      payloads[s] = await fetchSource(s);
    })
  );
  return deriveNavCounts(payloads);
}

export const STALE_MS = 60_000;

export interface NavCountsCache {
  /** When the cache was first filled this STALE_MS window. */
  at: number;
  counts: NavCounts;
  /** Sources already answered — by a fetch (even a failed one, so a dead
   *  source isn't re-hit on every navigation) or by a page seed. */
  covered: ReadonlySet<NavSource>;
}

function isFresh(cache: NavCountsCache | null, now: number): cache is NavCountsCache {
  return cache != null && now - cache.at < STALE_MS;
}

/** The sources a seed answers in full (a real number for every key). */
export function sourcesCoveredBy(counts: NavCounts | undefined): NavSource[] {
  if (!counts) return [];
  return NAV_SOURCES.filter((s) => SOURCE_KEYS[s].every((k) => typeof counts[k] === "number"));
}

/**
 * Pure: fold a page's server-computed seed into the cache. A stale cache is
 * dropped first; seed values win over cached ones (the page render that just
 * happened computed them). No seed and no fresh cache → null.
 */
export function applySeed(
  cache: NavCountsCache | null,
  seed: NavCounts | undefined,
  now: number
): NavCountsCache | null {
  const base = isFresh(cache, now) ? cache : null;
  const seeded: NavCounts = {};
  for (const k of Object.keys(seed ?? {}) as NavCountKey[]) {
    const v = seed?.[k];
    if (typeof v === "number" && Number.isFinite(v)) seeded[k] = v;
  }
  const covered = sourcesCoveredBy(seeded);
  if (covered.length === 0) return base;
  return {
    at: base ? base.at : now,
    counts: { ...(base?.counts ?? {}), ...seeded },
    covered: new Set([...(base?.covered ?? []), ...covered]),
  };
}

/** Pure: the sources still to fetch — everything the cache doesn't cover. */
export function sourcesToFetch(cache: NavCountsCache | null): NavSource[] {
  return NAV_SOURCES.filter((s) => !cache?.covered.has(s));
}

/** Pure: fold a fan-out's result into the cache. Fetched values only ever fill
 *  gaps — a seed's number for the same key is never overwritten by a fetch
 *  that was planned without it. */
export function mergeFetched(
  cache: NavCountsCache | null,
  fetched: NavCounts,
  sources: ReadonlyArray<NavSource>,
  now: number
): NavCountsCache {
  const base = isFresh(cache, now) ? cache : null;
  return {
    at: base ? base.at : now,
    counts: { ...fetched, ...(base?.counts ?? {}) },
    covered: new Set([...(base?.covered ?? []), ...sources]),
  };
}

let cache: NavCountsCache | null = null;

/** Test-only: drop the module cache so each case starts clean. */
export function __resetNavCountsCache(): void {
  cache = null;
  for (const s of NAV_SOURCES) delete inflight[s];
}

/**
 * Sidebar badge counts. `seed` is what the page already computed server-side
 * (AdminShell's `navCounts`); those keys render at once (and in SSR) and their
 * sources are not fetched. Everything else is fetched once per STALE_MS; until
 * it lands the key is absent, so no badge.
 */
export function useNavCounts(seed?: NavCounts): NavCounts {
  // The seed is a per-render object from server props; key the effect on its
  // content so a re-render with the same numbers doesn't replan.
  const seedKey = seed ? JSON.stringify(seed) : "";
  const [counts, setCounts] = useState<NavCounts>(
    () => applySeed(cache, seed, Date.now())?.counts ?? {}
  );

  useEffect(() => {
    let alive = true;
    cache = applySeed(cache, seed, Date.now());
    if (cache) setCounts(cache.counts);
    const todo = sourcesToFetch(cache);
    if (todo.length === 0) return;
    void loadNavCounts(todo).then((fetched) => {
      cache = mergeFetched(cache, fetched, todo, Date.now());
      if (alive) setCounts(cache.counts);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedKey IS the seed's identity
  }, [seedKey]);

  return counts;
}
