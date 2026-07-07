"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "next";
import {
  AlertOctagon,
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Images,
  Info,
  Map as MapIcon,
  MapPin,
  Zap,
} from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { PhilStatusBadge, type PhilStatusTone } from "./ui/PhilStatusBadge";
import { useOnline } from "./useOnline";
import { scheduleSummaryLine } from "@/domains/circuit-schedule/format";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import { needsWorkerAttention as snagNeedsAttention } from "@/domains/snags/format";
import { isCurrent } from "@/domains/documents/format";
import { isRequiredEvidenceMet } from "@/domains/job-control/task-context";
import type { Job, JobAreaGroup, JobStage } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Document } from "@/domains/documents/types";
import type { JobContact } from "@/domains/contacts/schema";
import type { TagItem } from "@/domains/tags/schema";
import type {
  EvidenceLink,
  ProofReview,
  WorkPackage,
} from "@/domains/job-control/types";
import type { TaskProgressRollup } from "@/domains/jobs/task-progress-rollup";
import type { AttentionItem } from "./PhilJobAttention";
import {
  roomForAttentionAnchor,
  type JobWorkCounts,
  type OwedProofItem,
  type PhilJobRoom,
} from "./philJobRooms";
import {
  areaStageAvailability,
  countsForArea,
  type AreaCountMaps,
} from "./philJobWorkTree";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobSnagsPanel } from "./JobSnagsPanel";
import { JobItpPanel } from "./JobItpPanel";
import { JobTagsPanel } from "./JobTagsPanel";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { PhilJobSiteCard, type SiteCardInduction } from "./PhilJobSiteCard";
import { PhilJobServicesCard } from "./PhilJobServicesCard";
import { PhilJobContactsCard } from "./PhilJobContactsCard";
import { PhilJobCrewCard } from "./PhilJobCrewCard";
import { PhilJobDeferredNote } from "./PhilJobDeferredNote";
import { PhilSafetyHomeSection } from "./PhilSafetyHomeSection";
import { PhilCertificatesHomeSection } from "./PhilCertificatesHomeSection";
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
  blockedByArea: ReadonlyMap<string, number>;
  owedByArea: ReadonlyMap<string, number>;
  areaCountMaps: AreaCountMaps;
  workPackages?: ReadonlyArray<WorkPackage>;
  evidenceLinks: ReadonlyArray<EvidenceLink>;
  snags: ReadonlyArray<SnagItem>;
  snagContext: { stage: JobStage | null; areaId: string | null };

  // ── Proof ──────────────────────────────────────────────────────────────
  owedProof: ReadonlyArray<OwedProofItem>;
  proofReviews: ReadonlyArray<ProofReview>;
  itps: ReadonlyArray<ITPInstance>;
  tags: ReadonlyArray<TagItem>;
  tagsError?: boolean;
  hasCircuitSchedule: boolean;
  circuitBoards?: ReadonlyArray<{ circuits?: ReadonlyArray<{ install?: string }> }>;
  certificatesEnabled: boolean;

  // ── Site ───────────────────────────────────────────────────────────────
  documents?: ReadonlyArray<Document>;
  documentsError: string | null;
  contacts?: ReadonlyArray<JobContact>;
  serviceLocations?: ReadonlyArray<ServiceLocationRecord>;
  serviceLocationsError: string | null;
  canWriteServiceLocations: boolean;
  onCapturePhotoForServices: () => Promise<EvidenceItem | null>;
  siteInduction: SiteCardInduction | null;
  safetyEnabled: boolean;
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

      {/* Honest absence — Materials + History aren't wired; say so, once. */}
      <PhilJobDeferredNote />
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
    blockedByArea,
    owedByArea,
    areaCountMaps,
    workPackages,
    evidenceLinks,
    snags,
    onOpenArea,
  } = props;

  // In-room reveals (reset when the room remounts on re-select).
  const [scopeOpen, setScopeOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);

  const openSnags = snags.filter((s) => snagNeedsAttention(s.status)).length;
  const hasScope = (workPackages?.length ?? 0) > 0;

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
                aria-label={`${workCounts.done} done, ${workCounts.going} going, ${workCounts.blocked} blocked, ${workCounts.todo} to do`}
              >
                <Segment count={workCounts.done} total={workCounts.total} className="bg-state-success" />
                <Segment count={workCounts.going} total={workCounts.total} className="bg-state-info" />
                <Segment count={workCounts.blocked} total={workCounts.total} className="bg-state-danger" />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {workCounts.blocked > 0 ? (
                  <PhilStatusBadge label={`${workCounts.blocked} blocked`} tone="danger" />
                ) : null}
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

      {/* Scope of work — ONLY when the office has really compiled work
          packages (the real artifact). Honest absence otherwise: no row. */}
      {hasScope ? (
        <section aria-label="Scope of work" className="space-y-1.5">
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            aria-expanded={scopeOpen}
            data-testid="phil-room-scope-row"
            className="flex min-h-[56px] w-full items-center gap-3 rounded-card border border-border bg-surface-raised px-4 py-3 text-left shadow-card transition-colors hover:bg-surface-subtle"
          >
            <ClipboardList aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-sm font-semibold text-text">
                Scope of work
              </span>
              <span className="mt-0.5 block truncate text-[12px] text-text-muted">
                {`What we're contracted to do — ${workPackages!.length} ${
                  workPackages!.length === 1 ? "package" : "packages"
                }`}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-5 w-5 shrink-0 text-text-muted transition-transform",
                scopeOpen ? "rotate-180" : "",
              )}
            />
          </button>
          {scopeOpen ? (
            <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
              {workPackages!.map((wp) => {
                const reqs = wp.requiredEvidence ?? [];
                const met = reqs.filter((r) =>
                  isRequiredEvidenceMet(evidenceLinks, wp.id, r.id),
                ).length;
                return (
                  <li key={wp.id} className="px-4 py-3">
                    <p className="break-words font-display text-sm font-semibold text-text">
                      {wp.title}
                    </p>
                    {wp.scopeNote ? (
                      <p className="mt-0.5 break-words text-[12px] text-text-muted">
                        {wp.scopeNote}
                      </p>
                    ) : null}
                    {reqs.length > 0 ? (
                      <p
                        className={cn(
                          "mt-1 text-[12px]",
                          met === reqs.length ? "text-state-success" : "text-state-warning",
                        )}
                      >
                        {`Proof ${met}/${reqs.length} captured`}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* Issues — the existing snags surface, one honest count on the row. */}
      {props.viewer ? (
        <section aria-label="Issues" className="space-y-1.5">
          <button
            type="button"
            onClick={() => setIssuesOpen((v) => !v)}
            aria-expanded={issuesOpen}
            data-testid="phil-room-issues-row"
            className="flex min-h-[56px] w-full items-center gap-3 rounded-card border border-border bg-surface-raised px-4 py-3 text-left shadow-card transition-colors hover:bg-surface-subtle"
          >
            <AlertOctagon
              aria-hidden="true"
              className={cn(
                "h-5 w-5 shrink-0",
                openSnags > 0 ? "text-state-warning" : "text-brand-navy",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-sm font-semibold text-text">
                Issues
              </span>
              <span className="mt-0.5 block text-[12px] text-text-muted">
                {openSnags > 0
                  ? `${openSnags} open`
                  : "Nothing open"}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-5 w-5 shrink-0 text-text-muted transition-transform",
                issuesOpen ? "rotate-180" : "",
              )}
            />
          </button>
          {issuesOpen ? (
            <JobSnagsPanel
              job={job}
              initialSnags={snags}
              context={props.snagContext}
              recentEvidence={props.evidenceItems}
              viewer={props.viewer}
            />
          ) : null}
        </section>
      ) : null}

      {/* Areas — grouped cards; tap opens the Area view. Counts are real:
          rollup per area, observation-derived blocked, compiled owed proof,
          viewer-scoped photos. */}
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
                  const blocked = blockedByArea.get(area.id) ?? 0;
                  const owed = owedByArea.get(area.id) ?? 0;
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
                          {blocked > 0 ? (
                            <PhilStatusBadge label={`${blocked} blocked`} tone="danger" />
                          ) : null}
                          {owed > 0 ? (
                            <PhilStatusBadge label="Proof needed" tone="warning" />
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
  const {
    job,
    owedProof,
    proofReviews,
    workPackages,
    onOpenArea,
    areaNames,
  } = props;

  const submitted = proofReviews.filter((r) => r.status === "submitted");
  const hasCompiledProof = (workPackages ?? []).some(
    (wp) => (wp.requiredEvidence?.length ?? 0) > 0,
  );

  return (
    <div className="space-y-4" data-testid="phil-room-proof">
      {/* Proof needed — real owed items at their AUTHORED granularity
          (package-granular today; a per-task-authored item stays task-scoped).
          Capture happens where the work is: a row opens its area in Work. */}
      <section aria-label="Proof needed" className="space-y-1.5">
        <SectionHeading>Proof needed</SectionHeading>
        {owedProof.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised shadow-card">
            {owedProof.map((item) => {
              const targetAreaId = item.areaIds.length === 1 ? item.areaIds[0]! : null;
              const areaLine = item.areaIds
                .map((id) => areaNames[id])
                .filter(Boolean)
                .join(" · ");
              const body = (
                <>
                  <Camera aria-hidden="true" className="h-5 w-5 shrink-0 text-state-warning" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-display text-sm font-semibold text-text">
                      {item.requirement.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-text-muted">
                      {[item.workPackageTitle, areaLine].filter(Boolean).join(" — ")}
                    </span>
                  </span>
                  <PhilStatusBadge label="Needs photo" className="shrink-0" />
                </>
              );
              return (
                <li key={`${item.workPackageId}:${item.requirement.id}`}>
                  {targetAreaId ? (
                    <button
                      type="button"
                      // onOpenArea lands in Work → this area (it owns the room
                      // switch), where the capture-proof flow lives.
                      onClick={() => onOpenArea(targetAreaId)}
                      className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-subtle"
                    >
                      {body}
                      <ChevronRight
                        aria-hidden="true"
                        className="h-5 w-5 shrink-0 text-text-muted/60"
                      />
                    </button>
                  ) : (
                    <div className="flex min-h-[56px] items-center gap-3 px-4 py-3">
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : hasCompiledProof ? (
          <PhilNotice tone="success" title="All required proof is captured." role="status">
            Everything the office asked for on this job is on file.
          </PhilNotice>
        ) : (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
            The office hasn&rsquo;t compiled proof requirements for this job yet —
            nothing is owed here.
          </p>
        )}
        {submitted.length > 0 ? (
          <p className="px-1 text-[12px] text-text-muted">
            {`${submitted.length} ${submitted.length === 1 ? "task is" : "tasks are"} waiting on review.`}
          </p>
        ) : null}
      </section>

      {/* Checks (ITP) — the existing panel wholesale (rows → recording pages). */}
      <JobItpPanel job={job} initialItps={props.itps} />

      {/* Boards & gear — existing surfaces stay reachable. */}
      {props.hasCircuitSchedule ? (
        <RouteRow
          href={`/phil/jobs/${encodeURIComponent(job.id)}/circuit-schedule`}
          icon={Zap}
          title="Circuit schedule"
          subtitle={scheduleSummaryLine(props.circuitBoards)}
        />
      ) : null}
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

      {/* #231 certificates — hidden-until-real, flag-gated by the page. */}
      {props.certificatesEnabled ? <PhilCertificatesHomeSection jobId={job.id} /> : null}
    </div>
  );
}

/* ── SITE — the paper and the people ─────────────────────────────────────── */

function SiteRoom(props: Props) {
  const { job, documents, documentsError, contacts } = props;
  const currentDocs = (documents ?? []).filter(isCurrent).length;

  return (
    <div className="space-y-4" data-testid="phil-room-site">
      {/* Paper — plans (current-rev filter is the viewer's own rule), safety
          docs (real unread count inside), site files. */}
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
        {props.safetyEnabled ? <PhilSafetyHomeSection jobId={job.id} /> : null}
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
