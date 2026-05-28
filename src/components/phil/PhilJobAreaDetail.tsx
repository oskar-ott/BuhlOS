"use client";

import { AlertOctagon, Camera, ChevronRight, ClipboardCheck } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { stageLabel } from "@/domains/jobs/format";
import type { JobStage, JobTaskTemplate } from "@/domains/jobs/types";
import {
  areaQuickLinks,
  hasAnyStage,
  soleStage,
  type AreaCounts,
  type AreaQuickLink,
  type AreaStageAvailability,
} from "./philJobWorkTree";
import { cn } from "@/lib/cn";

const LINK_ICON = {
  snags: AlertOctagon,
  itps: ClipboardCheck,
  photos: Camera,
} as const;

interface Props {
  areaName: string;
  spaceType?: string | null;
  /** Which stages have a task plan for this area. */
  stages: AreaStageAvailability;
  /** Currently-viewed stage (parent state). */
  stage: JobStage;
  /** Tasks for the currently-viewed stage (already resolved by parent). */
  tasks: ReadonlyArray<JobTaskTemplate>;
  /** Real, area-linked counts for this area. */
  counts: AreaCounts;
  onStageChange: (stage: JobStage) => void;
}

/**
 * Phil — Job area drill-in.
 *
 * The detail surface shown once a worker taps an area card, per the
 * Phil Job Interface Bible §09 ("an area is a small job inside the
 * job"). Replaces the bare "{stage} · {area}" task-list card with a
 * proper drill-in:
 *
 *   1. Area header (name + space type).
 *   2. "In this area" quick links — one chip per real, area-linked
 *      count (snags · area ITPs · photos). Each scrolls to the matching
 *      job section. Hidden entirely when nothing is outstanding.
 *   3. Stage selector — only when the area has BOTH a rough-in and a
 *      fit-off plan. With a single stage there's nothing to choose, so
 *      we show a static stage label instead (the parent has already
 *      synced `stage` to the sole stage on select).
 *   4. Task list for the viewed stage (read-only, unchanged).
 *
 * No new data: counts come from the maps the page already built;
 * stage availability from the task plan. Documents / materials / task
 * progress are deliberately absent — none are area-linked real data.
 *
 * Cross-ref:
 *   src/components/phil/philJobWorkTree.ts — soleStage / areaQuickLinks
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §09
 */
export function PhilJobAreaDetail({
  areaName,
  spaceType,
  stages,
  stage,
  tasks,
  counts,
  onStageChange,
}: Props) {
  const links = areaQuickLinks(counts);
  const sole = soleStage(stages);
  const showSelector = hasAnyStage(stages) && sole === null;
  // When the area has a single stage, that's what's shown; otherwise the
  // parent-controlled `stage` drives the list.
  const viewedStage: JobStage = sole ?? stage;

  return (
    <Card aria-label={`${areaName} detail`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="break-words">{areaName}</CardTitle>
          {spaceType ? (
            <CardDescription className="mt-1">{spaceType}</CardDescription>
          ) : null}
        </div>
      </div>

      {links.length > 0 ? (
        <div className="mt-3">
          <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
            In this area
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {links.map((link) => (
              <li key={link.key}>
                <QuickLink link={link} />
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-text-muted/80">
            Counts are for this area. Tap to open the job-wide list.
          </p>
        </div>
      ) : null}

      <div className="mt-4">
        {showSelector ? (
          <>
            <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
              Stage
            </p>
            <div
              className="mt-2 grid grid-cols-2 gap-2"
              role="tablist"
              aria-label="Stage"
            >
              <StageButton
                label={stageLabel("roughIn")}
                active={viewedStage === "roughIn"}
                onClick={() => onStageChange("roughIn")}
              />
              <StageButton
                label={stageLabel("fitOff")}
                active={viewedStage === "fitOff"}
                onClick={() => onStageChange("fitOff")}
              />
            </div>
          </>
        ) : hasAnyStage(stages) ? (
          <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
            {stageLabel(viewedStage)} tasks
          </p>
        ) : null}

        {hasAnyStage(stages) ? (
          tasks.length > 0 ? (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex min-h-[48px] items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-pill bg-text-muted/40"
                  />
                  <span className="flex-1 text-text">{t.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
              No {stageLabel(viewedStage).toLowerCase()} tasks listed for this
              area yet.
            </p>
          )
        ) : (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
            No task plan for this area yet. Your PM sets these up in the office
            app.
          </p>
        )}
      </div>
    </Card>
  );
}

function QuickLink({ link }: { link: AreaQuickLink }) {
  const Icon = LINK_ICON[link.key];
  return (
    <a
      href={link.anchor}
      className={cn(
        "inline-flex min-h-[40px] items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-sm",
        "transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy",
      )}
      aria-label={`${link.label} in this area — open the list`}
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="font-display font-medium text-text">{link.label}</span>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted/60" />
    </a>
  );
}

function StageButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-card border px-4 py-3 text-center font-display text-sm font-semibold transition-colors",
        active
          ? "border-accent-yellow bg-accent-yellow text-brand-navy"
          : "border-border bg-surface text-text hover:bg-surface-subtle",
      )}
    >
      {label}
    </button>
  );
}
