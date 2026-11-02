"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PhilOfflineLink } from "@/components/phil/PhilOfflineLink";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";
import { countsLine, datedItpTitle, listBadge } from "@/domains/itp-simple/model";
import {
  ItpCreatedReportSchema,
  ItpListResponseSchema,
  type ItpReportSummary,
} from "@/domains/itp-simple/schema";
import { isOnline } from "@/domains/phil/online";
import { ItpBadge, ItpPrimaryButton } from "./ItpControls";
import { ItpDock } from "./ItpDock";
import { itpApi, itpBase } from "./itpApi";
import { PhilItpWalkthrough, walkthroughLocalKey } from "./PhilItpWalkthrough";

/**
 * ITP list (board 2): intro "ITPs — Photos by area, made into a PDF." ·
 * cards newest first (title, "n areas · n photos", one badge; the whole
 * card is the tap target) · dock: Start an ITP + "Named with today's date.
 * Rename any time." One tap creates the report with the dated title and
 * goes straight to the builder — there is no title field.
 *
 * The first-open walkthrough shows here (never on the builder) when the
 * person's walkthroughSeen is false; if the list can't load, it isn't
 * shown and is checked again next time.
 */
export function PhilItpReportsList({ jobId, userId }: { jobId: string; userId: string }) {
  const router = useRouter();
  const [reports, setReports] = useState<ReadonlyArray<ItpReportSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [walkthrough, setWalkthrough] = useState(false);
  const base = itpBase(jobId);

  const syncSeen = useCallback(async () => {
    const r = await itpApi(`${base}&action=walkthrough`, { method: "PUT", body: "{}" });
    if (r.ok) {
      try {
        window.localStorage.setItem(walkthroughLocalKey(userId), "seen");
      } catch {
        /* storage blocked — the server copy is enough */
      }
    }
  }, [base, userId]);

  const load = useCallback(async () => {
    setError(null);
    const r = await itpApi(base);
    if (!r.ok) {
      setError(r.kind === "network" ? "Check you've got signal, then try again." : r.message);
      setReports([]);
      return;
    }
    const parsed = ItpListResponseSchema.safeParse(r.data);
    if (!parsed.success) {
      setError("The app couldn't read the reply — refresh to check.");
      setReports([]);
      return;
    }
    setReports(parsed.data.reports);

    let local: string | null = null;
    try {
      local = window.localStorage.getItem(walkthroughLocalKey(userId));
    } catch {
      local = null;
    }
    if (local === "seen-unsynced" && isOnline()) void syncSeen();
    if (parsed.data.walkthroughSeen === false && !local) setWalkthrough(true);
  }, [base, syncSeen, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  function closeWalkthrough() {
    setWalkthrough(false);
    try {
      window.localStorage.setItem(walkthroughLocalKey(userId), "seen-unsynced");
    } catch {
      /* ignore */
    }
    void syncSeen();
  }

  async function startReport() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await itpApi(base, {
      method: "POST",
      body: JSON.stringify({ title: datedItpTitle() }),
    });
    if (!r.ok) {
      setError(
        r.kind === "network"
          ? "No signal — couldn't start the ITP. Try again when you've got signal."
          : r.message
      );
      setBusy(false);
      return;
    }
    const parsed = ItpCreatedReportSchema.safeParse(r.data);
    if (!parsed.success) {
      setError("The app couldn't read the reply — refresh to check.");
      setBusy(false);
      return;
    }
    router.push(
      `/phil/jobs/${encodeURIComponent(jobId)}/itp-reports/${encodeURIComponent(parsed.data.report.id)}`
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <PhilPageIntro title="ITPs" description="Photos by area, made into a PDF." />

      {error ? (
        <PhilNotice tone="danger" title="Couldn't load the ITPs" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 inline-flex min-h-[44px] items-center font-display text-[16px] font-bold text-state-info"
          >
            Try again
          </button>
        </PhilNotice>
      ) : null}

      {reports === null ? (
        <>
          <PhilSkeletonCard />
          <PhilSkeletonCard />
        </>
      ) : reports.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-[16px] text-text">
          No ITPs on this job yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => {
            const badge = listBadge(r);
            return (
              <li key={r.id}>
                <PhilOfflineLink
                  href={`/phil/jobs/${encodeURIComponent(jobId)}/itp-reports/${encodeURIComponent(r.id)}`}
                  className="block rounded-card border border-border bg-surface p-4 focus-visible:outline-brand-navy"
                  data-testid="itp-report-card"
                >
                  <span className="line-clamp-2 block break-words font-display text-[18px] font-bold text-text">
                    {r.title}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px] font-semibold text-text-muted">
                    <span>{countsLine(r.areaCount, r.photoCount)}</span>
                    <ItpBadge tone={badge.tone}>{badge.label}</ItpBadge>
                  </span>
                </PhilOfflineLink>
              </li>
            );
          })}
        </ul>
      )}

      <ItpDock
        testId="itp-list-dock"
        primary={
          <>
            <ItpPrimaryButton
              onClick={() => void startReport()}
              disabled={busy || reports === null}
            >
              {busy ? "Starting…" : "Start an ITP"}
            </ItpPrimaryButton>
            <p className="mt-2 text-center text-[14px] font-semibold text-text-muted">
              Named with today&rsquo;s date. Rename any time.
            </p>
          </>
        }
      />

      <PhilItpWalkthrough open={walkthrough} onSkip={closeWalkthrough} onDone={closeWalkthrough} />
    </div>
  );
}
