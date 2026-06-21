import { weekWindowForLocalDate, isInWeek } from "./week";

/**
 * KPI engine (#329) — ONE definition per number, pure.
 *
 * Generalises the owner-numbers seed (#316, the six numbers each defined once)
 * into a reusable registry: every number is a KpiDefinition with a single
 * `compute`, a `unit`, a human `describe`, and a `definitionVersion` (bump when
 * the meaning changes so a stored value's basis is unambiguous). Evaluating a
 * definition stamps a KpiValue envelope. The point is that a number lives in
 * EXACTLY ONE place — surfaces read the registry, never re-derive.
 *
 * Pure + decoupled: definitions take their inputs explicitly (no fetch), so they
 * unit-test trivially. The owner-numbers six migrate onto this over time
 * (follow-up); this slice lands the engine + the first shared definition
 * (hours-this-week, built on the canonical week.ts).
 */

export interface KpiValue {
  id: string;
  label: string;
  /** The computed number. */
  value: number;
  /** "h" | "count" | "AUD" | "%" … */
  unit: string;
  /** ISO instant the value was evaluated at (caller-supplied — pure). */
  asOf: string;
  /** Bumped when the definition's meaning changes. */
  definitionVersion: number;
}

export interface KpiDefinition<I = unknown> {
  id: string;
  label: string;
  unit: string;
  definitionVersion: number;
  /** Plain-English definition — the single source of "what this number means". */
  describe: string;
  /** The ONE computation. Must be pure + total (return a finite number). */
  compute: (input: I) => number;
}

/** Identity helper that pins the generic — `defineKpi<MyInput>({...})`. */
export function defineKpi<I>(def: KpiDefinition<I>): KpiDefinition<I> {
  return def;
}

/** Evaluate a definition into a stamped envelope. Throws if a definition
 *  returns a non-finite number (a definition bug must surface, never ship NaN). */
export function evaluateKpi<I>(def: KpiDefinition<I>, input: I, asOf: string): KpiValue {
  const value = def.compute(input);
  if (!Number.isFinite(value)) {
    throw new Error(`KPI "${def.id}" computed a non-finite value`);
  }
  return { id: def.id, label: def.label, value, unit: def.unit, asOf, definitionVersion: def.definitionVersion };
}

/** A registry enforcing one-definition-per-id. */
export class KpiRegistry {
  private readonly defs = new Map<string, KpiDefinition<never>>();

  register<I>(def: KpiDefinition<I>): this {
    if (this.defs.has(def.id)) throw new Error(`KPI "${def.id}" is already defined`);
    this.defs.set(def.id, def as KpiDefinition<never>);
    return this;
  }
  has(id: string): boolean {
    return this.defs.has(id);
  }
  get<I = unknown>(id: string): KpiDefinition<I> | undefined {
    return this.defs.get(id) as KpiDefinition<I> | undefined;
  }
  ids(): string[] {
    return [...this.defs.keys()];
  }
  list(): KpiDefinition<never>[] {
    return [...this.defs.values()];
  }
  /** Evaluate a registered KPI by id; throws if unknown. */
  evaluate<I>(id: string, input: I, asOf: string): KpiValue {
    const def = this.get<I>(id);
    if (!def) throw new Error(`unknown KPI "${id}"`);
    return evaluateKpi(def, input, asOf);
  }
}

// ── First shared definition — hours this week (built on canonical week.ts) ────

export interface HoursThisWeekInput {
  /** Time entries with a local `date` (YYYY-MM-DD) and `hours`. */
  entries: ReadonlyArray<{ date: string; hours: number }>;
  /** Today's LOCAL (Australia/Sydney) date — the week anchor. */
  localToday: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const hoursThisWeekKpi = defineKpi<HoursThisWeekInput>({
  id: "hours.week.total",
  label: "Hours this week",
  unit: "h",
  definitionVersion: 1,
  describe:
    "Sum of logged hours whose entry date falls in the Mon–Sun week (Australia/Sydney) containing today.",
  compute: ({ entries, localToday }) => {
    const window = weekWindowForLocalDate(localToday);
    let total = 0;
    for (const e of entries) {
      if (isInWeek(e.date, window)) total += Number(e.hours) || 0;
    }
    return round2(total);
  },
});

/** A registry with the built-in shared definitions registered. More numbers
 *  (the owner-numbers six) migrate here over time. */
export function createKpiRegistry(): KpiRegistry {
  return new KpiRegistry().register(hoursThisWeekKpi);
}
