/**
 * Quantised percentage widths for data bars, as LITERAL Tailwind classes.
 * Inline styles are banned repo-wide (rebuild non-negotiable: UI rules) and
 * Tailwind's JIT can't see runtime-built class strings, so bars snap to 5%
 * steps from this fixed ladder. Counts stay honest — only the bar length is
 * rounded (max ±2.5%), and any non-zero count renders at least one step.
 */
const WIDTH_STEPS = [
  "w-0",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-[50%]",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
] as const;

export function pctWidthClass(count: number, total: number): string {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count <= 0) {
    return WIDTH_STEPS[0];
  }
  const idx = Math.min(
    WIDTH_STEPS.length - 1,
    Math.max(1, Math.round(((count / total) * 100) / 5)),
  );
  return WIDTH_STEPS[idx] ?? WIDTH_STEPS[0];
}
