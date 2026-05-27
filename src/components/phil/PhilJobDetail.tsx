"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  Camera,
  ChevronDown,
  ChevronRight,
  KeyRound,
  MapPin,
  Phone,
  ShieldAlert,
  Squircle,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import {
  effectiveTasks,
  hasSiteContext,
  stageLabel,
  visibleAreaGroups,
} from "@/domains/jobs/format";
import { needsWorkerAttention as itpNeedsAttention } from "@/domains/itp/format";
import { needsWorkerAttention as snagNeedsAttention } from "@/domains/snags/format";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";
import { CaptureSheet } from "./CaptureSheet";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobSnagsPanel } from "./JobSnagsPanel";
import { JobItpPanel } from "./JobItpPanel";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { JobMaterialsPanel } from "./JobMaterialsPanel";
import { JobHistoryPanel } from "./JobHistoryPanel";
import { PhilJobHero } from "./PhilJobHero";
import { PhilJobAttentionStrip } from "./PhilJobAttentionStrip";
import { PhilJobSectionAnchors } from "./PhilJobSectionAnchors";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
  /** Initial evidence list fetched server-side (server filters to own
   *  captures for tradie; admin/LH see all). May be empty on load. */
  initialEvidence?: ReadonlyArray<EvidenceItem>;
  /** Initial snags list fetched server-side. May be empty. */
  initialSnags?: ReadonlyArray<SnagItem>;
  /** Initial ITP instances list fetched server-side (Phase E1b).
   *  May be empty on load. */
  initialItps?: ReadonlyArray<ITPInstance>;
  /** Initial documents (plans + specs) fetched server-side (Phase E2).
   *  May be empty on load. */
  initialDocuments?: ReadonlyArray<Document>;
  /** Non-blocking error from the documents fetch — surfaces an info
   *  bar inside JobDocumentsPanel. Null when the fetch succeeded. */
  documentsError?: string | null;
  /** Current viewer — id + role drive snag transition button gating
   *  and attention-strip filters (e.g. "snags assigned to me"). */
  viewer?: { id: string; role: string };
}

/**
 * Phil single-job context view.
 *
 * Layout (top to bottom) — restructured per the Phil Job Interface
 * Bible §08 "Job Home" pattern:
 *
 *   1. Back link → /phil/jobs
 *   2. <PhilJobHero/> — job name + status pill + address summary
 *   3. <PhilJobAttentionStrip/> — strict, max 3, derived from real
 *      signals (rejected snags, assigned-to-me, pending ITPs,
 *      induction). Hidden when nothing qualifies.
 *   4. <PhilJobSectionAnchors/> — in-page jump chips so the worker
 *      can reach Site / Work / Capture / Snags / ITPs / Site files /
 *      Materials without endless scroll.
 *   5. Site card (#phil-job-site) — address / contact / access /
 *      parking / safety / induction. Collapsible.
 *   6. Work block (#phil-job-work) — stage chooser + area picker +
 *      effective task list (read-only).
 *   7. Capture block (#phil-job-capture) — primary CTA + today's
 *      capture strip.
 *   8. Snags (#phil-job-snags) — JobSnagsPanel (live).
 *   9. ITPs (#phil-job-itps) — JobItpPanel (live, Phase E1b).
 *  10. Documents (#phil-job-documents) — JobDocumentsPanel (UC stub
 *      until the E2 read-only slice lands).
 *  11. Materials (#phil-job-materials) — JobMaterialsPanel (UC).
 *  12. History (#phil-job-history) — JobHistoryPanel (UC).
 *
 * The Documents / Materials / History panels stay honest UC until
 * their dedicated slices land — no fake counts, no fake buttons.
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html
 *     §08 Job Home, §07 Needs Attention doctrine, §13 field rules
 *   docs/rebuild-audit/27-interface-usability-pass.md §4 + §8.5
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §3 + §7
 */
export function PhilJobDetail({
  job,
  initialEvidence,
  initialSnags,
  initialItps,
  initialDocuments,
  documentsError,
  viewer,
}: Props) {
  const groups = useMemo(() => visibleAreaGroups(job.areaGroups), [job.areaGroups]);

  // Flatten the visible areas across groups so the default selection
  // ("the first thing the worker sees") is stable regardless of how the
  // PM organised the groups.
  const flatAreas = useMemo(
    () =>
      groups.flatMap((g) =>
        (g.areas ?? []).map((a) => ({
          ...a,
          groupName: g.name,
          groupId: g.id,
        }))
      ),
    [groups]
  );

  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(
    flatAreas[0]?.id ?? null
  );
  const [stage, setStage] = useState<JobStage>("roughIn");
  const [siteOpen, setSiteOpen] = useState(true);

  const [captureOpen, setCaptureOpen] = useState(false);
  const [evidenceItems, setEvidenceItems] = useState<ReadonlyArray<EvidenceItem>>(
    initialEvidence ?? []
  );
  const [captureBanner, setCaptureBanner] = useState<
    { tone: "info" | "success" | "danger"; message: string } | null
  >(null);

  const selectedArea = useMemo(
    () => flatAreas.find((a) => a.id === selectedAreaId) ?? null,
    [flatAreas, selectedAreaId]
  );

  const tasks = useMemo(
    () => effectiveTasks(job, selectedArea, stage),
    [job, selectedArea, stage]
  );

  const showSiteContext = hasSiteContext(job);

  // Counts feeding the section-anchors chips. We use the same
  // "needsWorkerAttention" predicates the panels use to decide what
  // counts as visible — so the chip number agrees with the section
  // contents without a second source of truth.
  const snagsActive = useMemo(
    () =>
      (initialSnags ?? []).filter((s) => snagNeedsAttention(s.status)).length,
    [initialSnags],
  );
  const itpsActive = useMemo(
    () =>
      (initialItps ?? []).filter(
        (i) => !i.archived && itpNeedsAttention(i.status),
      ).length,
    [initialItps],
  );

  const handleCaptured = useCallback((item: EvidenceItem) => {
    setEvidenceItems((prev) => [item, ...prev]);
    setCaptureBanner({ tone: "success", message: "Evidence captured." });
    // Auto-decay the banner after 1.5s per doc 29 §7.7.
    window.setTimeout(() => setCaptureBanner(null), 1500);
  }, []);

  const handleCaptureFailed = useCallback((message: string) => {
    setCaptureBanner({ tone: "danger", message });
  }, []);

  return (
    <div className="space-y-4 pb-2">
      <div className="-mt-1">
        <Link
          href="/phil/jobs"
          className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← All jobs
        </Link>
      </div>

      <PhilJobHero job={job} />

      <PhilJobAttentionStrip
        job={job}
        snags={initialSnags ?? []}
        itps={initialItps ?? []}
        viewerId={viewer?.id ?? null}
      />

      <PhilJobSectionAnchors
        hasSite={showSiteContext}
        hasAreas={flatAreas.length > 0}
        snagsActive={snagsActive}
        itpsActive={itpsActive}
      />

      {showSiteContext ? (
        <section id="phil-job-site" aria-labelledby="phil-job-site-h" className="scroll-mt-16">
          <Card>
            <button
              type="button"
              onClick={() => setSiteOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 text-left"
              aria-expanded={siteOpen}
              aria-controls="phil-job-site-body"
            >
              <CardTitle className="m-0" >
                <span id="phil-job-site-h">Site</span>
              </CardTitle>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-5 w-5 shrink-0 text-text-muted transition-transform",
                  siteOpen ? "rotate-180" : ""
                )}
              />
            </button>
            {siteOpen ? (
              <dl id="phil-job-site-body" className="mt-3 space-y-3 text-sm">
                {job.siteAddress ? (
                  <SiteField icon={<MapPin className="h-4 w-4" />} label="Address">
                    {job.siteAddress}
                  </SiteField>
                ) : null}
                {(job.siteContactName?.trim() || job.siteContactPhone?.trim()) ? (
                  <SiteField icon={<User className="h-4 w-4" />} label="Contact">
                    {[
                      job.siteContactName?.trim(),
                      job.siteContactPhone?.trim() && (
                        <span key="phone" className="inline-flex items-center gap-1">
                          <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                          <a
                            href={`tel:${job.siteContactPhone!.replace(/\s+/g, "")}`}
                            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                          >
                            {job.siteContactPhone!.trim()}
                          </a>
                        </span>
                      ),
                    ]
                      .filter(Boolean)
                      .map((node, i) => (
                        <span key={i} className="block">
                          {node}
                        </span>
                      ))}
                  </SiteField>
                ) : null}
                {job.accessNotes ? (
                  <SiteField icon={<KeyRound className="h-4 w-4" />} label="Access">
                    {job.accessNotes}
                  </SiteField>
                ) : null}
                {job.parkingNotes ? (
                  <SiteField icon={<Squircle className="h-4 w-4" />} label="Parking">
                    {job.parkingNotes}
                  </SiteField>
                ) : null}
                {job.safetyNotes ? (
                  <SiteField icon={<ShieldAlert className="h-4 w-4" />} label="Safety">
                    {job.safetyNotes}
                  </SiteField>
                ) : null}
                {job.inductionRequired ? (
                  <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-amber-900">
                    <p className="font-display text-sm font-semibold">
                      Site induction required
                    </p>
                    <p className="mt-0.5 text-xs">
                      Confirm with your leading hand before starting.
                    </p>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </Card>
        </section>
      ) : null}

      {flatAreas.length > 0 ? (
        <section
          id="phil-job-work"
          aria-labelledby="phil-job-work-h"
          className="scroll-mt-16 space-y-4"
        >
          <Card>
            <CardTitle>
              <span id="phil-job-work-h">Stage</span>
            </CardTitle>
            <CardDescription className="mt-1">
              Which list of tasks should we show for the selected area?
            </CardDescription>
            <div className="mt-3 grid grid-cols-2 gap-2" role="tablist" aria-label="Stage">
              <StageButton
                label={stageLabel("roughIn")}
                active={stage === "roughIn"}
                onClick={() => setStage("roughIn")}
              />
              <StageButton
                label={stageLabel("fitOff")}
                active={stage === "fitOff"}
                onClick={() => setStage("fitOff")}
              />
            </div>
          </Card>

          {groups.length > 0 ? (
            <Card>
              <CardTitle>Areas</CardTitle>
              <CardDescription className="mt-1">
                Pick an area to see the {stageLabel(stage).toLowerCase()} task list.
              </CardDescription>
              <div className="mt-3 space-y-4">
                {groups.map((group) => {
                  const areas = group.areas ?? [];
                  if (areas.length === 0) return null;
                  return (
                    <div key={group.id}>
                      <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                        {group.name}
                      </p>
                      <ul
                        className="mt-2 grid gap-2"
                        role="listbox"
                        aria-label={`Areas in ${group.name}`}
                      >
                        {areas.map((area) => {
                          const active = area.id === selectedAreaId;
                          return (
                            <li key={area.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={active}
                                onClick={() => setSelectedAreaId(area.id)}
                                className={cn(
                                  "flex w-full items-center justify-between gap-3 rounded-card border px-4 py-3 text-left transition-colors",
                                  active
                                    ? "border-brand-navy bg-brand-navy text-text-inverse"
                                    : "border-border bg-surface hover:bg-surface-subtle"
                                )}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-display text-base font-semibold">
                                    {area.name}
                                  </span>
                                  {area.spaceType ? (
                                    <span
                                      className={cn(
                                        "block truncate text-xs",
                                        active ? "text-text-inverse/80" : "text-text-muted"
                                      )}
                                    >
                                      {area.spaceType}
                                    </span>
                                  ) : null}
                                </span>
                                <ChevronRight
                                  aria-hidden="true"
                                  className={cn(
                                    "h-5 w-5 shrink-0",
                                    active ? "text-accent-yellow" : "text-text-muted/60"
                                  )}
                                />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : (
            <Card>
              <CardTitle>Areas</CardTitle>
              <CardDescription className="mt-2">
                No areas configured for this job yet. Ask your PM or check the
                legacy Job Builder.
              </CardDescription>
            </Card>
          )}

          {selectedArea ? (
            <Card>
              <CardTitle>
                {stageLabel(stage)} · {selectedArea.name}
              </CardTitle>
              <CardDescription className="mt-1">
                The task plan for this area. Status and tick-off land in a later
                phase.
              </CardDescription>
              {tasks.length > 0 ? (
                <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
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
                <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
                  No {stageLabel(stage).toLowerCase()} tasks listed for this area.
                  The job-level template may be empty, or this area has a custom
                  override with no tasks.
                </p>
              )}
            </Card>
          ) : null}
        </section>
      ) : null}

      <section
        id="phil-job-capture"
        aria-labelledby="phil-job-capture-h"
        className="scroll-mt-16 space-y-4"
      >
        <Card>
          <CardTitle>
            <span id="phil-job-capture-h">Capture evidence</span>
          </CardTitle>
          <CardDescription className="mt-1">
            Take a photo (with an optional note) attached to this job. The selected
            stage and area carry through to the capture sheet.
          </CardDescription>
          <div className="mt-3">
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={() => {
                setCaptureBanner(null);
                setCaptureOpen(true);
              }}
              className="w-full bg-accent-yellow text-brand-navy hover:bg-accent-yellow"
            >
              <Camera aria-hidden="true" className="h-5 w-5" />
              Capture evidence
            </Button>
          </div>
        </Card>

        <TodaysCapturesStrip items={evidenceItems} banner={captureBanner} />
      </section>

      {viewer ? (
        <section
          id="phil-job-snags"
          aria-label="Snags"
          className="scroll-mt-16"
        >
          <JobSnagsPanel
            job={job}
            initialSnags={initialSnags}
            context={{ stage, areaId: selectedAreaId }}
            recentEvidence={evidenceItems}
            viewer={viewer}
          />
        </section>
      ) : null}

      {/* Job-interface sections. Order matches
          docs/rebuild-audit/34-phase-e-testing-checklist.md §B.2:
          header → site → stage → areas → capture → strip → Snags →
          ITPs, then Documents / Materials / History.

          JobItpPanel is LIVE as of Phase E1b. JobDocumentsPanel is
          LIVE as of Phase E2 (read-only). JobMaterialsPanel and
          JobHistoryPanel stay UC until their dedicated slices land
          in real implementations. */}
      <section id="phil-job-itps" aria-label="ITPs" className="scroll-mt-16">
        <JobItpPanel job={job} initialItps={initialItps} />
      </section>

      <section
        id="phil-job-documents"
        aria-label="Documents and specs"
        className="scroll-mt-16"
      >
        <JobDocumentsPanel
          initialDocuments={initialDocuments}
          fetchError={documentsError ?? null}
        />
      </section>

      <section
        id="phil-job-materials"
        aria-label="Materials"
        className="scroll-mt-16"
      >
        <JobMaterialsPanel />
      </section>

      <section
        id="phil-job-history"
        aria-label="Job history"
        className="scroll-mt-16"
      >
        <JobHistoryPanel />
      </section>

      <CaptureSheet
        open={captureOpen}
        job={job}
        initialContext={{ stage, areaId: selectedAreaId }}
        onClose={() => setCaptureOpen(false)}
        onCaptured={handleCaptured}
        onFailed={handleCaptureFailed}
      />
    </div>
  );
}

function SiteField({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="font-display text-[11px] uppercase tracking-wider text-text-muted">
          {label}
        </dt>
        <dd className="mt-0.5 whitespace-pre-line break-words text-text">{children}</dd>
      </div>
    </div>
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
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      {label}
    </button>
  );
}
