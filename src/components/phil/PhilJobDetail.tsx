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
import { Pill } from "@/components/ui/Pill";
import {
  effectiveTasks,
  hasSiteContext,
  stageLabel,
  statusLabel,
  statusTone,
  visibleAreaGroups,
} from "@/domains/jobs/format";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";
import { CaptureSheet } from "./CaptureSheet";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobSnagsPanel } from "./JobSnagsPanel";
import { JobItpPanel } from "./JobItpPanel";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { JobMaterialsPanel } from "./JobMaterialsPanel";
import { JobHistoryPanel } from "./JobHistoryPanel";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
  /** Initial evidence list fetched server-side (server filters to own
   *  captures for tradie; admin/LH see all). May be empty on load. */
  initialEvidence?: ReadonlyArray<EvidenceItem>;
  /** Initial snags list fetched server-side. May be empty. */
  initialSnags?: ReadonlyArray<SnagItem>;
  /** Current viewer — id + role drive snag transition button gating. */
  viewer?: { id: string; role: string };
}

/**
 * Phil single-job context view.
 *
 * Layout (top to bottom):
 *   1. Back link → /phil/jobs
 *   2. Job header card: status pill, job name, ref/type
 *   3. Site context: address / access / parking / safety / induction
 *      (expanded by default, collapsible)
 *   4. Stage chooser: Rough-in / Fit-off pills (equal weight)
 *   5. Area picker: vertical list grouped by area group
 *   6. Task list: effective tasks for the selected area + stage (read-only)
 *   7. Capture evidence — primary CTA opens <CaptureSheet />
 *   8. Today's captures — <TodaysCapturesStrip /> with own evidence
 *
 * Phase D3 replaces D1's two UnderConstructionPanels (Capture evidence
 * + Today's captures) with the live capture flow consuming D2's
 * evidence API. The stage + areaId selected above carry through as
 * initialContext into the sheet so the worker doesn't re-tap.
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §4 + §8.5
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §3 + §7
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6 Phil
 */
export function PhilJobDetail({ job, initialEvidence, initialSnags, viewer }: Props) {
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

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="break-words">{job.name}</CardTitle>
            {(job.ref || job.typeName) && (
              <CardDescription className="mt-1">
                {[job.ref && `Ref ${job.ref}`, job.typeName].filter(Boolean).join(" · ")}
              </CardDescription>
            )}
          </div>
          <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
        </div>
      </Card>

      {showSiteContext ? (
        <Card>
          <button
            type="button"
            onClick={() => setSiteOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={siteOpen}
            aria-controls="site-context-body"
          >
            <CardTitle>Site</CardTitle>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-5 w-5 shrink-0 text-text-muted transition-transform",
                siteOpen ? "rotate-180" : ""
              )}
            />
          </button>
          {siteOpen ? (
            <dl id="site-context-body" className="mt-3 space-y-3 text-sm">
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
      ) : null}

      {flatAreas.length > 0 ? (
        <Card>
          <CardTitle>Stage</CardTitle>
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
      ) : null}

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

      <Card>
        <CardTitle>Capture evidence</CardTitle>
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

      {viewer ? (
        <JobSnagsPanel
          job={job}
          initialSnags={initialSnags}
          context={{ stage, areaId: selectedAreaId }}
          recentEvidence={evidenceItems}
          viewer={viewer}
        />
      ) : null}

      {/* Job-interface stubs — under construction until the next E-phase
          slices land. Order matches docs/rebuild-audit/34-phase-e-testing-
          checklist.md §B.2 (header → site → stage → areas → capture → strip
          → Snags → ITPs), then Documents / Materials / History.
          Real implementations drop into these component files in their
          own PRs (E1b for JobItpPanel, E2 for JobDocumentsPanel, E3 for
          JobMaterialsPanel, later phase for JobHistoryPanel). */}
      <JobItpPanel />
      <JobDocumentsPanel />
      <JobMaterialsPanel />
      <JobHistoryPanel />

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
