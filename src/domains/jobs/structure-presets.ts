import type { AreaGroupRowForm, AreaRowForm, TaskRowForm } from "./builder";

/**
 * Structure presets (#192) — the CLIENT half: turning a saved preset back
 * into builder form rows. Capture is server-side (api/structure-presets.js,
 * reusing the duplicate-job mapper family: ids stripped, archived skipped,
 * no task state); insertion happens here and flows through the builder's
 * normal validated PUT, where the server mints fresh ids for id-less rows —
 * the same fresh-ids-by-construction trick as job duplication.
 */

export interface StructurePresetGroup {
  name: string;
  areas: ReadonlyArray<{
    name: string;
    spaceType?: string;
    order?: number;
    roughInTasks?: ReadonlyArray<{ name: string; order?: number }>;
    fitOffTasks?: ReadonlyArray<{ name: string; order?: number }>;
  }>;
}

export interface StructurePreset {
  id: string;
  name: string;
  group: StructurePresetGroup;
  sourceJobId?: string;
  createdAt?: string;
  createdByName?: string;
}

function copyTasks(
  tasks: ReadonlyArray<{ name: string; order?: number }> | undefined,
): TaskRowForm[] | undefined {
  if (!tasks || tasks.length === 0) return undefined;
  return tasks.map((t) => ({ name: t.name }));
}

function copyArea(area: StructurePresetGroup["areas"][number]): AreaRowForm {
  const out: AreaRowForm = { name: area.name };
  if (area.spaceType) out.spaceType = area.spaceType;
  const ri = copyTasks(area.roughInTasks);
  if (ri) out.roughInTasks = ri;
  const fo = copyTasks(area.fitOffTasks);
  if (fo) out.fitOffTasks = fo;
  return out;
}

/**
 * Auto-numbered group names: "Unit 8", "Unit 9", … starting ABOVE the
 * highest existing "<base> <n>" so an existing "Unit 7" never collides
 * (the AC's exact case). A single insert keeps the bare base name when
 * it's free; otherwise it's numbered like the rest.
 */
export function autoNumberedNames(
  base: string,
  count: number,
  existing: ReadonlyArray<string>,
): string[] {
  const trimmed = base.trim() || "Group";
  const taken = new Set(existing.map((n) => n.trim()));
  if (count <= 1 && !taken.has(trimmed)) return [trimmed];

  const pattern = new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)$`);
  let max = 0;
  for (const name of taken) {
    const m = pattern.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const names: string[] = [];
  let n = max + 1;
  while (names.length < Math.max(1, count)) {
    const candidate = `${trimmed} ${n}`;
    if (!taken.has(candidate)) names.push(candidate);
    n += 1;
  }
  return names;
}

/** One fresh builder group per name — no ids anywhere, server mints them. */
export function instantiatePreset(
  preset: Pick<StructurePreset, "group">,
  names: ReadonlyArray<string>,
): AreaGroupRowForm[] {
  return names.map((name) => ({
    name,
    areas: preset.group.areas.map(copyArea),
  }));
}
