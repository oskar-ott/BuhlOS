"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PhilActionButton } from "@/components/phil/ui/PhilActionButton";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";
import {
  ItpListResponseSchema,
  ItpPdfResponseSchema,
  ItpReportResponseSchema,
  pdfMissingNewCaptures,
  type ItpReportDetail,
  type ItpReportSummary,
} from "@/domains/itp-simple/schema";

/**
 * Simple mobile ITP builder (#912, lean-reset step 6) — the Phil client for
 * `/api/itp-simple`. Two screens:
 *   - list: this job's reports + "Start ITP"
 *   - builder: one report — areas named on the walk, photos per area,
 *     "Make the PDF"
 * Site language throughout (P11); every state is real data or a real error —
 * no placeholders (P7). Refetch-after-write keeps it dumb and correct on 4G:
 * only metadata moves, photos upload once.
 */

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the photo"));
    reader.readAsDataURL(file);
  });
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
  }).format(new Date(t));
}

// ── List screen ─────────────────────────────────────────────────────────

export function PhilItpReportsList({ jobId }: { jobId: string }) {
  const [reports, setReports] = useState<ReadonlyArray<ItpReportSummary> | null>(null);
  const [jobName, setJobName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const raw = await api(`/api/itp-simple?jobId=${encodeURIComponent(jobId)}`);
      const parsed = ItpListResponseSchema.parse(raw);
      setReports(parsed.reports);
      setJobName(parsed.job.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the ITPs");
      setReports([]);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function startReport() {
    const clean = title.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/itp-simple?jobId=${encodeURIComponent(jobId)}`, {
        method: "POST",
        body: JSON.stringify({ title: clean }),
      });
      setTitle("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the ITP");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PhilPageIntro
        title="ITPs"
        description={
          jobName
            ? `Inspection reports for ${jobName}. Walk the job, drop photos into areas, make the PDF.`
            : "Walk the job, drop photos into areas, make the PDF."
        }
      />

      {error ? (
        <PhilNotice tone="warning" title="Something went wrong" role="alert">
          <p>{error}</p>
        </PhilNotice>
      ) : null}

      {reports === null ? (
        <PhilSkeletonCard />
      ) : reports.length === 0 ? (
        <p className="text-sm text-text-muted">
          No ITPs on this job yet. Name the first one and get walking.
        </p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id}>
              <Link
                href={`/phil/jobs/${encodeURIComponent(jobId)}/itp-reports/${encodeURIComponent(r.id)}`}
                className="block rounded-card border border-border bg-surface p-4"
              >
                <span className="block font-semibold text-text">{r.title}</span>
                <span className="mt-1 block text-xs text-text-muted">
                  {r.areaCount === 1 ? "1 area" : `${r.areaCount} areas`}
                  {" · "}
                  {r.photoCount === 1 ? "1 photo" : `${r.photoCount} photos`}
                  {r.pdfGeneratedAt ? ` · PDF made ${shortDate(r.pdfGeneratedAt)}` : " · no PDF yet"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-card border border-border bg-surface p-4">
        <label htmlFor="itp-new-title" className="block text-sm font-semibold text-text">
          Start a new ITP
        </label>
        <input
          id="itp-new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Rough-in — Level 1"
          maxLength={120}
          className="h-11 w-full rounded-card border border-border bg-background px-3 text-base text-text"
        />
        <PhilActionButton onClick={() => void startReport()} disabled={!title.trim() || busy}>
          {busy ? "Starting…" : "Start ITP"}
        </PhilActionButton>
      </div>
    </div>
  );
}

// ── Builder screen ──────────────────────────────────────────────────────

export function PhilItpReportBuilder({ jobId, reportId }: { jobId: string; reportId: string }) {
  const [report, setReport] = useState<ItpReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [areaName, setAreaName] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // action key, e.g. "area", "photo:<id>", "pdf"
  // Arm-then-confirm for destructive taps (house pattern, PhilCircuitSchedule):
  // first tap arms one key, the second tap on the same control executes.
  const [armed, setArmed] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const base = `/api/itp-simple?jobId=${encodeURIComponent(jobId)}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const raw = await api(`${base}&id=${encodeURIComponent(reportId)}`);
      setReport(ItpReportResponseSchema.parse(raw).report);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load this ITP");
    } finally {
      setLoading(false);
    }
  }, [base, reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save");
    } finally {
      setBusy(null);
    }
  }

  function addArea() {
    const name = areaName.trim();
    if (!name) return;
    void run("area", async () => {
      await api(`${base}&action=area`, {
        method: "POST",
        body: JSON.stringify({ reportId, name }),
      });
      setAreaName("");
    });
  }

  function addPhotos(areaId: string, files: FileList | null) {
    if (!files || !files.length) return;
    const picked = Array.from(files);
    void run(`photo:${areaId}`, async () => {
      for (const file of picked) {
        const dataUrl = await readFileAsDataUrl(file);
        await api(`${base}&action=photo`, {
          method: "POST",
          body: JSON.stringify({ areaId, dataUrl }),
        });
      }
    });
  }

  function deletePhoto(photoId: string) {
    const key = `del:${photoId}`;
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setArmed(null);
    void run(key, async () => {
      await api(`${base}&action=photo`, { method: "DELETE", body: JSON.stringify({ id: photoId }) });
    });
  }

  function deleteArea(areaId: string) {
    const key = `delarea:${areaId}`;
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setArmed(null);
    void run(key, async () => {
      await api(`${base}&action=area`, { method: "DELETE", body: JSON.stringify({ id: areaId }) });
    });
  }

  function makePdf() {
    void run("pdf", async () => {
      const raw = await api(`${base}&action=pdf`, {
        method: "POST",
        body: JSON.stringify({ reportId }),
      });
      ItpPdfResponseSchema.parse(raw);
    });
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <PhilSkeletonCard />
        <PhilSkeletonCard />
      </div>
    );
  }

  if (!report) {
    return (
      <PhilNotice tone="warning" title="Couldn't load this ITP" role="alert">
        <p>{error ?? "It may have been removed, or the link is out of date."}</p>
      </PhilNotice>
    );
  }

  const photoCount = report.areas.reduce((n, a) => n + a.photos.length, 0);
  const newSincePdf = pdfMissingNewCaptures(report);

  return (
    <div className="space-y-4">
      <PhilPageIntro
        title={report.title}
        description={
          photoCount
            ? `${report.areas.length === 1 ? "1 area" : `${report.areas.length} areas`} · ${photoCount === 1 ? "1 photo" : `${photoCount} photos`}`
            : "Name the first area, then drop photos in as you walk."
        }
      />

      {error ? (
        <PhilNotice tone="warning" title="Something went wrong" role="alert">
          <p>{error}</p>
        </PhilNotice>
      ) : null}

      {report.areas.map((area) => (
        <section key={area.id} className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-semibold text-text">{area.name}</h2>
            <button
              type="button"
              onClick={() => deleteArea(area.id)}
              disabled={busy !== null}
              className={
                armed === `delarea:${area.id}`
                  ? "rounded-card bg-status-danger px-2 py-1 text-xs font-medium text-text-inverse"
                  : "text-xs text-text-muted underline"
              }
            >
              {armed === `delarea:${area.id}` ? "Tap again to remove this area" : "Remove"}
            </button>
          </div>

          {area.photos.length ? (
            <ul className="mt-3 grid grid-cols-3 gap-2">
              {area.photos.map((p) => (
                <li key={p.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.caption || `Photo in ${area.name}`}
                    className="aspect-square w-full rounded-card border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={
                      armed === `del:${p.id}` ? "Tap again to remove this photo" : "Remove this photo"
                    }
                    onClick={() => deletePhoto(p.id)}
                    disabled={busy !== null}
                    className={
                      armed === `del:${p.id}`
                        ? "absolute inset-x-1 top-1 rounded-full bg-status-danger px-2 py-1 text-xs font-medium text-text-inverse shadow"
                        : "absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-surface/90 text-sm text-text shadow"
                    }
                  >
                    {armed === `del:${p.id}` ? "Remove?" : "✕"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-text-muted">No photos here yet.</p>
          )}

          <input
            ref={(el) => {
              fileInputs.current[area.id] = el;
            }}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => {
              addPhotos(area.id, e.target.files);
              e.target.value = "";
            }}
          />
          <PhilActionButton
            size="md"
            className="mt-3"
            disabled={busy !== null}
            onClick={() => fileInputs.current[area.id]?.click()}
          >
            {busy === `photo:${area.id}` ? "Uploading…" : "Add photos"}
          </PhilActionButton>
        </section>
      ))}

      <div className="space-y-2 rounded-card border border-border bg-surface p-4">
        <label htmlFor="itp-new-area" className="block text-sm font-semibold text-text">
          Add an area
        </label>
        <input
          id="itp-new-area"
          value={areaName}
          onChange={(e) => setAreaName(e.target.value)}
          placeholder="e.g. Kitchen, Switchboard, Roof"
          maxLength={120}
          className="h-11 w-full rounded-card border border-border bg-background px-3 text-base text-text"
        />
        <PhilActionButton size="md" onClick={addArea} disabled={!areaName.trim() || busy !== null}>
          {busy === "area" ? "Adding…" : "Add area"}
        </PhilActionButton>
      </div>

      <div className="space-y-2">
        {report.pdfUrl ? (
          <p className="text-sm text-text-muted">
            <a href={report.pdfUrl} target="_blank" rel="noreferrer" className="underline">
              Open the PDF
            </a>
            {report.pdfGeneratedAt ? ` — made ${shortDate(report.pdfGeneratedAt)}` : ""}
            {newSincePdf ? ". Photos added since aren't in it." : ""}
          </p>
        ) : null}
        <PhilActionButton onClick={makePdf} disabled={busy !== null || photoCount === 0}>
          {busy === "pdf" ? "Making the PDF…" : report.pdfUrl ? "Make the PDF again" : "Make the PDF"}
        </PhilActionButton>
        {photoCount === 0 ? (
          <p className="text-xs text-text-muted">Add at least one photo first.</p>
        ) : null}
      </div>
    </div>
  );
}
