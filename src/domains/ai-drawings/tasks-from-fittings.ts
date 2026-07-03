// #213 adjacent — suggest job TASKS from AI-detected plan fittings. Pure trade
// mapping: aggregated fitting labels + counts → proposed job-level rough-in /
// fit-off tasks (with honest quantities). This is a SUGGESTION only; the caller
// surfaces a review step and the admin explicitly adds accepted tasks to the
// job-level task templates. It never auto-seeds and never authors area-owned
// task arrays (task-led ADR) — accepted tasks live at job level, the sanctioned
// storage the canonical task index derives from.
//
// Honesty (P7): quantities come from real detected counts; a fitting label the
// rules don't recognise is reported in `unmatched`, never turned into an
// invented task.

export interface TaskSuggestion {
  name: string;
  quantity: number;
  stage: "roughIn" | "fitOff";
  /** The fitting labels that contributed to this task. */
  sourceLabels: string[];
}

export interface TasksFromFittings {
  roughIn: TaskSuggestion[];
  fitOff: TaskSuggestion[];
  /** Fitting labels no rule matched — surfaced honestly, never invented into tasks. */
  unmatched: Array<{ label: string; count: number }>;
}

const plural = (n: number, suffix = "s") => (n === 1 ? "" : suffix);

// Ordered — first match wins. `board` sits before `switch` so "switchboard"
// isn't mis-matched as a light switch.
const RULES: ReadonlyArray<{
  id: string;
  match: RegExp;
  roughIn?: (n: number) => string;
  fitOff?: (n: number) => string;
}> = [
  {
    id: "power",
    // Deliberately NOT bare "outlet" — that's ambiguous with "data outlet"; a
    // lone "outlet" honestly falls to `unmatched` rather than mis-becoming power.
    match: /\b(gpo|power ?point|socket|power)\b/i,
    roughIn: (n) => `Rough-in power — ${n} point${plural(n)}`,
    fitOff: (n) => `Fit off ${n} GPO${plural(n)}`,
  },
  {
    id: "board",
    match: /(switchboard|distribution ?board|\bdb\b|\bmsb\b|\bmeter\b)/i,
    roughIn: () => `Switchboard rough-in`,
    fitOff: () => `Terminate & label switchboard`,
  },
  {
    id: "lighting",
    match: /(downlight|light|batten|luminaire|\bled\b|oyster|pendant)/i,
    roughIn: (n) => `Rough-in lighting — ${n} point${plural(n)}`,
    fitOff: (n) => `Install ${n} light${plural(n)}`,
  },
  {
    id: "data",
    match: /(data|network|comms|rj45|cat ?6|ethernet)/i,
    roughIn: (n) => `Rough-in data — ${n} outlet${plural(n)}`,
    fitOff: (n) => `Terminate ${n} data outlet${plural(n)}`,
  },
  {
    id: "smoke",
    match: /smoke/i,
    fitOff: (n) => `Install ${n} smoke alarm${plural(n)}`,
  },
  {
    id: "exhaust",
    match: /(exhaust|extract|\bfan\b)/i,
    fitOff: (n) => `Install ${n} exhaust fan${plural(n)}`,
  },
  {
    id: "switch",
    match: /switch/i,
    fitOff: (n) => `Fit off ${n} switch${plural(n, "es")}`,
  },
];

/**
 * @param fittings aggregated `{ label, count }` across the job's plans (the panel
 *   sums the ai-drawings by-room counts). Zero/negative counts are ignored.
 */
export function suggestTasksFromFittings(
  fittings: ReadonlyArray<{ label: string; count: number }>,
): TasksFromFittings {
  const byRule = new Map<number, { count: number; labels: Set<string> }>();
  const unmatched: Array<{ label: string; count: number }> = [];

  for (const f of fittings) {
    const label = (f.label ?? "").trim();
    const count = Number(f.count) || 0;
    if (!label || count <= 0) continue;
    const ruleIndex = RULES.findIndex((r) => r.match.test(label));
    if (ruleIndex < 0) {
      unmatched.push({ label, count });
      continue;
    }
    const acc = byRule.get(ruleIndex) ?? { count: 0, labels: new Set<string>() };
    acc.count += count;
    acc.labels.add(label);
    byRule.set(ruleIndex, acc);
  }

  const roughIn: TaskSuggestion[] = [];
  const fitOff: TaskSuggestion[] = [];
  // Emit in rule order for a stable, readable list.
  for (let i = 0; i < RULES.length; i++) {
    const acc = byRule.get(i);
    if (!acc || acc.count <= 0) continue;
    const rule = RULES[i]!;
    const sourceLabels = Array.from(acc.labels).sort();
    if (rule.roughIn) {
      roughIn.push({ name: rule.roughIn(acc.count), quantity: acc.count, stage: "roughIn", sourceLabels });
    }
    if (rule.fitOff) {
      fitOff.push({ name: rule.fitOff(acc.count), quantity: acc.count, stage: "fitOff", sourceLabels });
    }
  }

  return { roughIn, fitOff, unmatched };
}
