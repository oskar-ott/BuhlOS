"use client";

import type { ComponentType, SVGProps } from "react";
import { AlertOctagon, Camera, ChevronRight, ClipboardCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AreaCounts, AreaStageAvailability } from "./philJobWorkTree";

interface Props {
  name: string;
  spaceType?: string | null;
  active: boolean;
  stages: AreaStageAvailability;
  counts: AreaCounts;
  onSelect: () => void;
}

interface CountChip {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Visible label, already pluralised. */
  label: string;
  /** Accent class for the icon on the *inactive* card. On the active
   *  (navy) card every chip inverts to the same translucent style. */
  accent: string;
}

/**
 * Phil — Job work-tree area card.
 *
 * One area rendered as a selectable card, per the Phil Job Interface
 * Bible §09: area name + space type, the stages that have a task plan,
 * and real per-area counts (snags · area ITPs · photos). Tapping the
 * card selects the area — identical behaviour to the plain button it
 * replaces — and the stage chooser above still drives which task list
 * shows below.
 *
 * Chips only render when there's something real to show: a stage chip
 * appears only when that stage has tasks; a count chip appears only when
 * the count is > 0. An area with no plan and nothing outstanding renders
 * as just its name — honest, not padded with zeroes.
 *
 * The whole card is the tap target (min-height 64px) so it works with
 * gloves / dirty hands per the Bible's field rules (§13).
 *
 * Cross-ref:
 *   src/components/phil/philJobWorkTree.ts — count + stage derivation
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §09
 */
export function PhilJobAreaCard({
  name,
  spaceType,
  active,
  stages,
  counts,
  onSelect,
}: Props) {
  const stageChips: string[] = [];
  if (stages.roughIn) stageChips.push("Rough-in");
  if (stages.fitOff) stageChips.push("Fit-off");

  const countChips: CountChip[] = [];
  if (counts.snags > 0) {
    countChips.push({
      icon: AlertOctagon,
      label: counts.snags === 1 ? "1 snag" : `${counts.snags} snags`,
      accent: "text-rose-600",
    });
  }
  if (counts.itps > 0) {
    countChips.push({
      icon: ClipboardCheck,
      label: counts.itps === 1 ? "1 ITP" : `${counts.itps} ITPs`,
      accent: "text-sky-700",
    });
  }
  if (counts.photos > 0) {
    countChips.push({
      icon: Camera,
      label: counts.photos === 1 ? "1 photo" : `${counts.photos} photos`,
      accent: "text-text-muted",
    });
  }

  const ariaSummary = [
    stageChips.length ? stageChips.join(" and ") : null,
    counts.snags > 0
      ? `${counts.snags} ${counts.snags === 1 ? "snag" : "snags"}`
      : null,
    counts.itps > 0
      ? `${counts.itps} ${counts.itps === 1 ? "ITP" : "ITPs"}`
      : null,
    counts.photos > 0
      ? `${counts.photos} ${counts.photos === 1 ? "photo" : "photos"}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-label={ariaSummary ? `${name} — ${ariaSummary}` : name}
      onClick={onSelect}
      className={cn(
        "flex w-full min-h-[64px] items-center justify-between gap-3 rounded-card border px-4 py-3 text-left transition-colors",
        active
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface hover:bg-surface-subtle",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-base font-semibold">
          {name}
        </span>
        {spaceType ? (
          <span
            className={cn(
              "block truncate text-xs",
              active ? "text-text-inverse/80" : "text-text-muted",
            )}
          >
            {spaceType}
          </span>
        ) : null}

        {stageChips.length > 0 || countChips.length > 0 ? (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {stageChips.map((label) => (
              <span
                key={label}
                className={cn(
                  "inline-flex items-center rounded-pill border px-2 py-0.5 text-[11px] font-medium",
                  active
                    ? "border-text-inverse/30 text-text-inverse/90"
                    : "border-border bg-surface-subtle text-text-muted",
                )}
              >
                {label}
              </span>
            ))}
            {countChips.map((chip) => {
              const Icon = chip.icon;
              return (
                <span
                  key={chip.label}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[11px] font-medium",
                    active
                      ? "border-text-inverse/25 bg-text-inverse/10 text-text-inverse"
                      : "border-border bg-surface text-text",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      "h-3 w-3 shrink-0",
                      active ? "text-text-inverse/80" : chip.accent,
                    )}
                  />
                  {chip.label}
                </span>
              );
            })}
          </span>
        ) : null}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "h-5 w-5 shrink-0",
          active ? "text-accent-yellow" : "text-text-muted/60",
        )}
      />
    </button>
  );
}
