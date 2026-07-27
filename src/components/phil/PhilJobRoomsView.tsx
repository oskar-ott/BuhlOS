"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { Route } from "next";
import {
  AlertOctagon,
  AlertTriangle,
  Camera,
  ChevronRight,
  Images,
  Info,
  Map as MapIcon,
  MapPin,
} from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { PhilStatusBadge, type PhilStatusTone } from "./ui/PhilStatusBadge";
import { useOnline } from "./useOnline";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import { isCurrent } from "@/domains/documents/format";
import type { Job, JobAreaGroup } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Document } from "@/domains/documents/types";
import type { JobContact } from "@/domains/contacts/schema";
import type { TagItem } from "@/domains/tags/schema";
import type { TaskProgressRollup } from "@/domains/jobs/task-progress-rollup";
import type { AttentionItem } from "./PhilJobAttention";
import {
  roomForAttentionAnchor,
  type JobWorkCounts,
  type PhilJobRoom,
} from "./philJobRooms";
import {
  areaStageAvailability,
  countsForArea,
  type AreaCountMaps,
} from "./philJobWorkTree";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobTagsPanel } from "./JobTagsPanel";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { PhilJobSiteCard, type SiteCardInduction } from "./PhilJobSiteCard";
import { PhilJobServicesCard } from "./PhilJobServicesCard";
import { PhilJobContactsCard } from "./PhilJobContactsCard";
import { PhilJobCrewCard } from "./PhilJobCrewCard";
import { moduleEnabled } from "@/domains/jobs/builder";
import type { ServiceLocationRecord } from "@/domains/services-locations/types";
import { cn } from "@/lib/cn";

// jobs-domain status tone → sharpened badge tone (same mapping as W2a).
const JOB_BADGE_TONE: Record<ReturnType<typeof statusTone>, PhilStatusTone> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

const ATTENTION_ICON = {
  danger: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
} as const;

const ATTENTION_ICON_CLASS = {
  danger: "text-state-danger",
  warning: "text-state-warning",
  info: "text-state-info",
} as const;

// The repo bans inline styles; Tailwind only JIT-generates width classes that
// appear as literals in source — so bar fills snap to 5% buckets via a static
// class list (same rule as components/ui/Bar.tsx, which owns the plain bars;
// this local copy drives the SEGMENTED whole-job bar + the span-based area
// mini bar, which Bar's div markup can't express inside a <button>).
const BAR_WIDTHS = [
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
  "w-1/2",
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

function barWidthClass(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  return BAR_WIDTHS[Math.round(clamped / 5)] ?? "w-0";
}

interface Props {
  job: Job;
  /** The active room + a seq that bumps on every room select, so re-selecting
   *  the active tab remounts the room at its top (nav semantics). */
  room: PhilJobRoom;
  roomResetSeq: number;
  onGoToRoom: (room: PhilJobRoom) => void;
  /** Work-room area drill-in. The Area view itself is composed by the parent
   *  (it owns the task/toggle/proof wiring) and slotted in here. */
  areaOpen: boolean;
  onOpenArea: (areaId: string) => void;
  areaView: ReactNode;

  // ── Now ────────────────────────────────────────────────────────────────
  attention: { items: AttentionItem[]; total: number };
  evidenceItems: ReadonlyArray<EvidenceItem>;
  captureBanner: { tone: "info" | "success" | "danger"; message: string } | null;
  areaNames: Record<string, string>;
  viewer?: { id: string; role: string };
  onEvidenceUpdated: (item: EvidenceItem) => void;
  onOpenCapture: () => void;

  // ── Work ───────────────────────────────────────────────────────────────
  groups: ReadonlyArray<JobAreaGroup>;
  workCounts: JobWorkCounts;
  taskStatePending: boolean;
  taskStateErr: string | null;
  jobComplete: boolean;
  rollup: TaskProgressRollup;
  areaCountMaps: AreaCountMaps;

  // ── Proof ──────────────────────────────────────────────────────────────
  tags: ReadonlyArray<TagItem>;
  tagsError?: boolean;

  // ── Site ───────────────────────────────────────────────────────────────
  documents?: ReadonlyArray<Document>;
  documentsError: string | null;
  contacts?: ReadonlyArray<JobContact>;
  serviceLocations?: ReadonlyArray<ServiceLocationRecord>;
  serviceLocationsError: string | null;
  canWriteServiceLocations: boolean;
  onCapturePhotoForServices: () => Promise<EvidenceItem | null>;
  siteInduction: SiteCardInduction | null;
}

/**
 * The in-job FOUR ROOMS takeover (phil_job_rooms, dark — the filed #133
 * experiment). Renders /phil/jobs/[jobId] as Now · Work · Proof · Site, with
 * the room chosen by the in-job bottom bar (PhilTabBar rebinds via
 * philJobRoomsBar). Every room is a PROJECTION composed from the SAME section
 * components and derived data the one-scroll page uses — nothing re-fetched,
 * no domain logic rewritten, no invented numbers. Flag off ⇒ this component
 * never mounts and the current job screen renders byte-identically.
 */
export function PhilJobRoomsView(props: Props) {
  const { job, room, roomResetSeq, areaOpen, areaView } = props;

  // Selecting a room (or re-selecting the active one) resets it to its top —
  // the room content remounts via the seq key; this scrolls the shared Phil
  // scroll container back to the job header.
  const topRef = useRef<HTMLDivElement>(null);
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    topRef.current?.scrollIntoView({ block: "start" });
  }, [room, roomResetSeq]);

  return (
    <div ref={topRef} className="space-y-4 pb-2" data-testid="phil-job-rooms">
      {/* Header exit — the global sharpened bar returns on the jobs list. */}
      <div className="-mt-1">
        <PhilOfflineLink
          href="/phil/jobs"
          className="inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Jobs
        </PhilOfflineLink>
      </div>

      <JobIdentityHeader job={job} />

      {/* Room content — keyed so re-selecting the active tab resets the room
          (local toggles + sub-views) to its root. The Work room's area
          drill-in is parent state, not local, so resume-by-place survives. */}
      <div key={`${room}:${roomResetSeq}`}>
        {room === "now" ? <NowRoom {...props} /> : null}
        {room === "work" ? (
          areaOpen ? (
            areaView
          ) : (
            <WorkRoom {...props} />
          )
        ) : null}
        {room === "proof" ? <ProofRoom {...props} /> : null}
        {room === "site" ? <SiteRoom {...props} /> : null}
      </div>
    </div>
  );
}

/* ── Header — job identity + truthful sync pill (§2.3, no fake switcher) ── */

/** Initials tile from the REAL job name (same derivation rule as the header
 *  avatar) — never fabricated codes. */
function jobTileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function JobIdentityHeader({ job }: { job: Job }) {
  // Online + no outbox (none exists) → Synced; offline → Offline. The same
  // truthful model the sharpened My Day pill uses (useOnline; no invented
  // per-write sync state). SSR/first paint renders online.
  const online = useOnline();
  const chip = job.code ?? job.ref;
  const initials = jobTileInitials(job.name);
  return (
    <header
      data-testid="phil-job-rooms-header"
      className="rounded-card border border-border bg-surface-raised p-4 shadow-card"
    >
      <div className="flex items-center gap-3">
        {initials ? (
          <span
            aria-hidden="true"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-brand-navy font-display text-sm font-bold text-text-inverse"
          >
            {initials}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          {chip ? (
            <span className="block font-display text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted [font-variant-numeric:tabular-nums]">
              {chip}
            </span>
          ) : null}
          <h1 className="break-words font-display text-[19px] font-extrabold leading-tight tracking-[-0.02em] text-text">
            {job.name}
          </h1>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          {online ? (
            <PhilStatusBadge label="Synced" tone="success" />
          ) : (
            <PhilStatusBadge label="Offline" />
          )}
          <PhilStatusBadge
            label={statusLabel(job.status)}
            tone={JOB_BADGE_TONE[statusTone(job.status)]}
          />
        </span>
      </div>
      {job.siteAddress ? (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-text-muted">
          <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="truncate">{job.siteAddress}</span>
        </p>
      ) : null}
    </header>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
      {children}
    </h2>
  );
}

/** A row-card link into an existing Phil route (capability preservation). */
function RouteRow({
  href,
  icon: Icon,
  title,
  subtitle,
}: {
  href: string;
  icon: typeof MapIcon;
  title: string;
  subtitle?: string | null;
}) {
  return (
    <PhilOfflineLink
      href={href as Route}
      className="flex min-h-[56px] items-center gap-3 rounded-card border border-border bg-surface-raised px-4 py-3 shadow-card transition-colors hover:bg-surface-subtle"
    >
      <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-sm font-semibold text-text">
          {title}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[12px] text-text-muted">
            {subtitle}
          </span>
        ) : null}
      </span>
      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/60" />
    </PhilOfflineLink>
  );
}

/* ── NOW — what today needs (never a task recommender, P4) ───────────────── */

function NowRoom(props: Props) {
  const { attention, onGoToRoom } = props;
  return (
    <div className="space-y-4" data-testid="phil-room-now">
      {/* Needs you — the real viewer-scoped signals (deriveAttention). Each row
          navigates to the ROOM that owns its surface, so a critical signal is
          one tap from here — never a dead anchor. Absent when nothing
          qualifies (no fake "all clear"). */}
      {attention.items.length > 0 ? (
        <section aria-label="Needs you" className="space-y-1.5">
          <SectionHeading>{`Needs you · ${attention.total}`}</SectionHeading>
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised shadow-card">
            {attention.items.map((item) => {
              const Icon = ATTENTION_ICON[item.tone];
              const target = roomForAttentionAnchor(item.anchor);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onGoToRoom(target)}
                    data-testid={`phil-room-needs-you-${item.id}`}
                    className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-subtle"
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn("h-5 w-5 shrink-0", ATTENTION_ICON_CLASS[item.tone])}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-display text-sm font-semibold text-text">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block break-words text-[12px] text-text-muted">
                        {item.reasonShown}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="h-5 w-5 shrink-0 text-text-muted/60"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Today at this job — capture-first. The button opens the EXISTING job
          CaptureSheet (same path as the flag-off Capture block); the strip is
          the same component, real captures only. */}
      <section aria-label="Today at this job" className="space-y-1.5">
        <SectionHeading>Today at this job</SectionHeading>
        <PhilActionButton size="lg" onClick={props.onOpenCapture}>
          <Camera aria-hidden="true" className="h-5 w-5" />
          Capture evidence
        </PhilActionButton>
        <TodaysCapturesStrip
          items={props.evidenceItems}
          banner={props.captureBanner}
          areaNames={props.areaNames}
          jobId={props.job.id}
          viewerId={props.viewer?.id}
          onItemUpdated={props.onEvidenceUpdated}
        />
      </section>

      {/* On site today — real time-entry crew (self-fetching, degrades). */}
      <PhilJobCrewCard jobId={props.job.id} viewerId={props.viewer?.id ?? null} />
    </div>
  );
}

/* ── WORK — the whole job's work, drilled by place ───────────────────────── */

function WorkRoom(props: Props) {
  const {
    job,
    groups,
    workCounts,
    taskStatePending,
    taskStateErr,
    jobComplete,
    rollup,
    areaCountMaps,
    onOpenArea,
  } = props;

  return (
    <div className="space-y-4" data-testid="phil-room-work">
      {jobComplete ? (
        <PhilNotice tone="success" title="Every task here is done." role="status">
          Nice work — the whole job&rsquo;s ticked off. Checks and proof live in
          the Proof room if anything needs a look.
        </PhilNotice>
      ) : null}

      {/* Whole job — real rolled-up counts (canonical index). While the task
          state streams, a skeleton — never a false zero (P7). */}
      <section aria-label="Whole job" className="space-y-1.5">
        <SectionHeading>Whole job</SectionHeading>
        <div className="rounded-card border border-border bg-surface-raised p-4 shadow-card">
          {taskStatePending ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading job progress">
              <PhilSkeleton className="h-5 w-1/2" />
              <PhilSkeleton className="h-2.5 w-full" />
            </div>
          ) : workCounts.total > 0 ? (
            <>
              <p className="font-display text-[17px] font-bold tracking-[-0.014em] text-text">
                {`${workCounts.done} of ${workCounts.total} tasks done`}
              </p>
              {taskStateErr ? (
                <p className="mt-1 text-[12px] text-state-warning">
                  Progress may be stale — it couldn&rsquo;t load. Refresh to be sure.
                </p>
              ) : null}
              <div
                className="mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-pill bg-surface-subtle"
                role="img"
                aria-label={`${workCounts.done} done, ${workCounts.going} going, ${workCounts.todo} to do`}
              >
                <Segment count={workCounts.done} total={workCounts.total} className="bg-state-success" />
                <Segment count={workCounts.going} total={workCounts.total} className="bg-state-info" />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {workCounts.going > 0 ? (
                  <PhilStatusBadge label={`${workCounts.going} going`} tone="info" />
                ) : null}
                {workCounts.todo > 0 ? (
                  <PhilStatusBadge label={`${workCounts.todo} to do`} tone="neutral" />
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-text-muted">
              No tasks on this job yet. Your PM sets the plan up in the office app.
            </p>
          )}
        </div>
      </section>

      {/* Areas — grouped cards; tap opens the Area view. Counts are real:
          rollup per area and viewer-scoped photos. */}
      {groups.length > 0 ? (
        groups.map((group) => {
          const areas = group.areas ?? [];
          if (areas.length === 0) return null;
          return (
            <section key={group.id} aria-label={`Areas — ${group.name}`} className="space-y-1.5">
              <SectionHeading>{`Areas — ${group.name}`}</SectionHeading>
              <ul className="space-y-2">
                {areas.map((area) => {
                  const progress = rollup.byArea[area.id];
                  const stages = areaStageAvailability(job, area);
                  const counts = countsForArea(areaCountMaps, area.id);
                  return (
                    <li key={area.id}>
                      <button
                        type="button"
                        onClick={() => onOpenArea(area.id)}
                        data-testid={`phil-room-area-card-${area.id}`}
                        className="w-full rounded-card border border-border bg-surface-raised px-4 py-3 text-left shadow-card transition-colors hover:bg-surface-subtle"
                      >
                        <span className="flex min-h-[44px] items-center gap-3">
                          <span className="min-w-0 flex-1">
                            <span className="block break-words font-display text-base font-semibold text-text">
                              {area.name}
                            </span>
                          </span>
                          {!taskStatePending && progress && progress.total > 0 ? (
                            <span className="shrink-0 text-[13px] font-semibold text-text-muted [font-variant-numeric:tabular-nums]">
                              {`${progress.complete}/${progress.total}`}
                            </span>
                          ) : null}
                          <ChevronRight
                            aria-hidden="true"
                            className="h-5 w-5 shrink-0 text-text-muted/60"
                          />
                        </span>
                        {!taskStatePending && progress && progress.total > 0 ? (
                          <span className="mt-2 block h-1.5 overflow-hidden rounded-pill bg-surface-subtle">
                            <span
                              className={cn(
                                "block h-full rounded-pill bg-state-success",
                                barWidthClass((progress.complete / progress.total) * 100),
                              )}
                            />
                          </span>
                        ) : null}
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          {stages.roughIn ? (
                            <PhilStatusBadge label="Rough-in" tone="neutral" />
                          ) : null}
                          {stages.fitOff ? (
                            <PhilStatusBadge label="Fit-off" tone="neutral" />
                          ) : null}
                          {counts.photos > 0 ? (
                            <PhilStatusBadge
                              label={`${counts.photos} ${counts.photos === 1 ? "photo" : "photos"}`}
                              tone="neutral"
                            />
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      ) : (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
          No areas configured for this job yet. Ask your PM or check the Job
          Builder.
        </p>
      )}
    </div>
  );
}

function Segment({
  count,
  total,
  className,
}: {
  count: number;
  total: number;
  className: string;
}) {
  if (count === 0 || total === 0) return null;
  return <div className={cn(className, barWidthClass((count / total) * 100))} />;
}

/* ── PROOF — "am I covered?" in one room ─────────────────────────────────── */

function ProofRoom(props: Props) {
  const { job } = props;

  return (
    <div className="space-y-4" data-testid="phil-room-proof">
      {moduleEnabled(job, "tags") ? (
        <JobTagsPanel jobId={job.id} initialTags={props.tags} loadError={props.tagsError} />
      ) : null}

      {/* Evidence — the read-only gallery, linked only when captures exist. */}
      {props.evidenceItems.length > 0 ? (
        <RouteRow
          href={`/phil/jobs/${encodeURIComponent(job.id)}/photos`}
          icon={Images}
          title="All photos"
          subtitle="Every photo on this job — date-grouped, read-only"
        />
      ) : null}
    </div>
  );
}

/* ── SITE — the paper and the people ─────────────────────────────────────── */

function SiteRoom(props: Props) {
  const { job, documents, documentsError, contacts } = props;
  const currentDocs = (documents ?? []).filter(isCurrent).length;

  return (
    <div className="space-y-4" data-testid="phil-room-site">
      {/* Paper — plans (current-rev filter is the viewer's own rule) and
          site files. */}
      <section aria-label="Paper" className="space-y-2">
        <SectionHeading>Paper</SectionHeading>
        {moduleEnabled(job, "plans") ? (
          <RouteRow
            href={`/phil/jobs/${encodeURIComponent(job.id)}/plans`}
            icon={MapIcon}
            title="Plans"
            subtitle={
              currentDocs > 0
                ? `${currentDocs} current — the field sees current only`
                : "The field sees current revisions only"
            }
          />
        ) : null}
        <JobDocumentsPanel initialDocuments={documents} fetchError={documentsError} />
      </section>

      {/* Getting on site — the real site fields only (PhilJobSiteCard renders
          nothing when the job has no site context). Open by default here —
          this room IS the reference surface. */}
      <PhilJobSiteCard job={job} induction={props.siteInduction} defaultOpen />

      {/* Services on site (#230) — where the pit/board/meter are. */}
      <PhilJobServicesCard
        jobId={job.id}
        initialRecords={props.serviceLocations}
        loadError={props.serviceLocationsError}
        canWrite={props.canWriteServiceLocations}
        onCapturePhoto={props.onCapturePhotoForServices}
      />

      {/* Who to call — real categorised contacts with working Call buttons. */}
      {contacts && contacts.length > 0 ? (
        <PhilJobContactsCard contacts={contacts} />
      ) : null}
    </div>
  );
}
