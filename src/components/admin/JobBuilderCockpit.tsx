import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ClipboardList } from "lucide-react";
import type { BuilderReadiness } from "@/domains/jobs/builder";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { Bar, type BarTone } from "@/components/ui/Bar";
import { cn } from "@/lib/cn";

/**
 * The Job Builder cockpit shell (§4) — the three-column scope-to-field frame the
 * tabbed builder is upgraded into: LEFT rail (live readiness meter + grouped
 * section nav with per-section status) · CENTER canvas (the active section,
 * unchanged) · RIGHT inspector.
 *
 * Presentational only — it owns no builder state. JobBuilderClient passes the
 * real readiness model (buildBuilderReadiness over the SAVED job), the nav with
 * per-section status, the active section node as `canvas`, and the Inspector as
 * `inspector`. Responsive: the rail stacks above the canvas on small screens
 * (its nav wraps like the old tab row); the inspector is a wide-screen companion
 * (xl+) — on narrower screens its content (the publish/readiness detail) is
 * still reachable via the Publish section, so nothing is lost.
 */

export type CockpitSectionStatus = "block" | "warn" | "ok" | "none";

export interface CockpitNavItem {
  key: string;
  label: string;
  status: CockpitSectionStatus;
  /** Preserved data-testid for the section's nav button (smoke + deep-links). */
  testId?: string;
  /** Wave 2 (job_builder_redesign) — live step sub-label ("4 to triage",
   *  "9 on"). Real counts only; omitted when the data is absent (P7). Rendered
   *  only while `redesign` is on. */
  sub?: string;
}

export interface CockpitNavGroup {
  heading: string;
  items: CockpitNavItem[];
}

const READINESS_TONE: Record<BuilderReadiness["tone"], StatusTone> = {
  danger: "danger",
  warning: "warning",
  success: "success",
};

function SectionEnd({ status }: { status: CockpitSectionStatus }) {
  if (status === "block") {
    return <AlertTriangle className="h-3.5 w-3.5 text-state-danger" aria-label="Has blockers" />;
  }
  if (status === "warn") {
    return <AlertTriangle className="h-3.5 w-3.5 text-state-warning" aria-label="Has warnings" />;
  }
  if (status === "ok") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-state-success" aria-label="Clear" />;
  }
  return null;
}

interface JobBuilderCockpitProps {
  readiness: BuilderReadiness;
  nav: ReadonlyArray<CockpitNavGroup>;
  activeKey: string;
  onSelect: (key: string) => void;
  /** Open the publish section from the meter (counts are clickable). */
  onMeterClick?: () => void;
  /** Count of scope lines still to triage — shows a pinned Review queue rail
   *  entry when set. Omit (undefined) to hide the entry entirely. */
  reviewCount?: number;
  /** Whether the review queue is the active canvas. */
  reviewActive?: boolean;
  onOpenReview?: () => void;
  /** Wave 2 (job_builder_redesign) — rail readiness bar + step sub-labels.
   *  Off (default) = today's rail, byte-for-byte. */
  redesign?: boolean;
  canvas: ReactNode;
  inspector: ReactNode;
}

export function JobBuilderCockpit({
  readiness,
  nav,
  activeKey,
  onSelect,
  onMeterClick,
  reviewCount,
  reviewActive,
  onOpenReview,
  redesign = false,
  canvas,
  inspector,
}: JobBuilderCockpitProps) {
  // Wave 2 (job_builder_redesign) — the rail readiness summary rolls up the
  // nav items' OWN statuses (the same real per-section scoring the row icons
  // show); "none" items are un-scored sections and don't count either way.
  const scored = nav.flatMap((g) => g.items).filter((i) => i.status !== "none");
  const okCount = scored.filter((i) => i.status === "ok").length;
  const warnCount = scored.filter((i) => i.status === "warn").length;
  const blockCount = scored.filter((i) => i.status === "block").length;
  const railTone: BarTone = blockCount > 0 ? "danger" : warnCount > 0 ? "warning" : "success";
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_19rem]">
      {/* LEFT — readiness meter + section nav */}
      <aside className="flex flex-col gap-3" aria-label="Job builder readiness and sections">
        <div
          data-testid="cockpit-readiness-meter"
          className="rounded-card border border-border bg-surface p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
              Build readiness
            </span>
            <StatusChip tone={READINESS_TONE[readiness.tone]}>{readiness.stateLabel}</StatusChip>
          </div>
          {redesign && scored.length > 0 ? (
            <div className="mt-3" data-testid="cockpit-rail-readiness">
              <Bar
                pct={(okCount / scored.length) * 100}
                tone={railTone}
                aria-label="Sections ready"
              />
              <p className="mt-1.5 font-mono text-[12px] text-text-muted">
                {`${okCount} ready · ${warnCount} review · ${blockCount} block`}
              </p>
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onMeterClick}
              className="rounded-card border border-border bg-surface-subtle px-2 py-1.5 text-left transition-colors hover:border-state-danger"
            >
              <span className="block font-mono text-lg font-semibold text-text">
                {readiness.blockingCount}
              </span>
              <span className="block text-[11px] text-text-muted">
                Blocker{readiness.blockingCount === 1 ? "" : "s"} · stop publish
              </span>
            </button>
            <button
              type="button"
              onClick={onMeterClick}
              className="rounded-card border border-border bg-surface-subtle px-2 py-1.5 text-left transition-colors hover:border-state-warning"
            >
              <span className="block font-mono text-lg font-semibold text-text">
                {readiness.warningCount}
              </span>
              <span className="block text-[11px] text-text-muted">
                Warning{readiness.warningCount === 1 ? "" : "s"} · advisory
              </span>
            </button>
          </div>
        </div>

        {reviewCount !== undefined && onOpenReview ? (
          <button
            type="button"
            data-testid="cockpit-open-review"
            aria-current={reviewActive ? "page" : undefined}
            onClick={onOpenReview}
            className={cn(
              "flex items-center gap-2 rounded-card border px-3 py-2 text-left text-sm font-medium transition-colors",
              reviewActive
                ? "border-brand-navy bg-brand-navy text-text-inverse"
                : "border-border bg-surface text-text hover:bg-surface-subtle"
            )}
          >
            <ClipboardList className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Review queue</span>
            {reviewCount > 0 ? (
              <span className="shrink-0 rounded-pill bg-accent-yellow px-1.5 font-mono text-[11px] font-semibold text-brand-navy">
                {reviewCount}
              </span>
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-state-success" aria-label="All triaged" />
            )}
          </button>
        ) : null}

        <nav
          aria-label="Job builder sections"
          className="flex flex-wrap gap-1 rounded-card border border-border bg-surface p-1 lg:flex-col lg:flex-nowrap"
        >
          {nav.map((group) => (
            <div key={group.heading} className="contents lg:block">
              <p className="hidden px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-text-muted lg:block">
                {group.heading}
              </p>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-testid={item.testId}
                  aria-current={activeKey === item.key ? "page" : undefined}
                  onClick={() => onSelect(item.key)}
                  className={cn(
                    "flex items-center gap-2 rounded-card px-3 py-1.5 text-left text-sm font-medium transition-colors lg:w-full",
                    activeKey === item.key
                      ? "bg-brand-navy text-text-inverse"
                      : "text-text-muted hover:bg-surface-subtle hover:text-text"
                  )}
                >
                  {redesign && item.sub ? (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      <span
                        data-testid="cockpit-nav-sub"
                        className={cn(
                          "block truncate font-mono text-[12px] font-normal",
                          // NOT text-text-inverse/70 — that token is hex, so the
                          // opacity modifier renders dark ink on the navy row.
                          activeKey === item.key ? "text-white/70" : "text-text-muted"
                        )}
                      >
                        {item.sub}
                      </span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  )}
                  <SectionEnd status={item.status} />
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* CENTER — the active section */}
      <main className="min-w-0">{canvas}</main>

      {/* RIGHT — inspector (wide-screen companion) */}
      <aside className="hidden xl:block" aria-label="Inspector">
        <div className="sticky top-4">{inspector}</div>
      </aside>
    </div>
  );
}
