"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import { FilePlus2, Hash, LayoutTemplate, MapPin, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { createJob } from "@/domains/jobs/client";
import { buildCreatePayload } from "@/domains/jobs/builder";
import { validateJobBasics } from "@/domains/jobs/validate";
import {
  blueprintSummaryLine,
  instantiateBlueprint,
  listBlueprints,
  type JobBlueprint,
} from "@/domains/jobs/blueprints";
import { cn } from "@/lib/cn";

/**
 * NewJobRedesign — Wave 1 of the Job Builder redesign (flag `job_builder_redesign`,
 * dark). The prototype's "Start a new job" screen: two side-by-side paths — Start
 * blank (name is the one hard requirement) and Start from a blueprint — each
 * creating a DRAFT and routing into the builder.
 *
 * PURE RE-SKIN: reuses the exact create/blueprint logic the current New Job screen
 * already uses (`createJob` / `buildCreatePayload` / `validateJobBasics` /
 * `listBlueprints` / `instantiateBlueprint`). No behaviour change, no new data, no
 * new API. Honest empty state when no blueprints exist — never a fake template (P7).
 *
 * Renders inside AdminShell (the page owns the shell chrome); this is the body.
 */
export function NewJobRedesign() {
  const router = useRouter();

  // ── Start blank ──────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [blankSubmitting, setBlankSubmitting] = useState(false);
  const [blankError, setBlankError] = useState<string | null>(null);

  const fieldErrors = validateJobBasics({ name }, { requireName: true });
  const canCreateBlank = Object.keys(fieldErrors).length === 0 && !blankSubmitting;

  async function createBlank() {
    setShowErrors(true);
    if (Object.keys(fieldErrors).length > 0) return;
    setBlankSubmitting(true);
    setBlankError(null);
    const res = await createJob(
      buildCreatePayload({
        name,
        ref: ref.trim() || undefined,
        siteAddress: siteAddress.trim() || undefined,
      }),
    );
    if (!res.ok) {
      setBlankSubmitting(false);
      setBlankError(res.error.message);
      return;
    }
    router.push(`/v2/jobs/${encodeURIComponent(res.data.job.id)}/builder` as Route);
  }

  // ── Start from a blueprint ───────────────────────────────────────────────
  const [blueprints, setBlueprints] = useState<JobBlueprint[] | null>(null);
  const [bpLoadError, setBpLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bpName, setBpName] = useState("");
  const [bpSubmitting, setBpSubmitting] = useState(false);
  const [bpError, setBpError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listBlueprints();
      if (cancelled) return;
      if (!res.ok) {
        setBpLoadError(res.error.message);
        setBlueprints([]);
        return;
      }
      setBlueprints(res.data.blueprints);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = blueprints?.find((b) => b.id === selectedId) ?? null;

  async function createFromBlueprint() {
    if (!selected) return;
    setBpSubmitting(true);
    setBpError(null);
    const res = await createJob(instantiateBlueprint(selected, bpName || selected.name));
    if (!res.ok) {
      setBpSubmitting(false);
      setBpError(res.error.message);
      return;
    }
    router.push(`/v2/jobs/${encodeURIComponent(res.data.job.id)}/builder` as Route);
  }

  return (
    <div className="mx-auto max-w-5xl">
      {/* Hero */}
      <div className="mb-6">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
          <span className="inline-block h-2 w-2 rounded-full bg-accent-yellow" aria-hidden="true" />
          New job · creates a draft
        </p>
        <h1 className="mt-2 font-display text-3xl font-extrabold text-brand-navy">Start a new job</h1>
        <p className="mt-2 max-w-2xl text-sm text-text-muted">
          A new job starts as a <span className="font-semibold text-text">draft</span> — office-only,
          invisible to the crew until you publish it to the field. Start from a blank spine, or pre-fill the
          structure from one of your saved templates. Nothing goes to site until the publish gate is
          clear.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Start blank */}
        <section
          className="rounded-card border border-border bg-surface p-5"
          data-testid="new-job-blank"
          aria-labelledby="new-job-blank-title"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-card bg-brand-navy text-accent-yellow">
                <FilePlus2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="new-job-blank-title" className="font-display text-lg font-bold text-brand-navy">
                  Start blank
                </h2>
                <p className="text-xs text-text-muted">Empty spine · build it yourself</p>
              </div>
            </div>
            <Pill tone="neutral">One-off work</Pill>
          </div>

          {blankError ? (
            <p
              role="alert"
              className="mt-4 rounded-card border border-state-danger bg-rose-50 px-3 py-2 text-sm text-state-danger"
            >
              {blankError}
            </p>
          ) : null}

          <div className="mt-4 space-y-3">
            <Field label="Job name" required error={showErrors ? fieldErrors.name : undefined} icon={<Zap className="h-4 w-4" />}>
              <input
                data-testid="job-name"
                autoFocus
                className={cn(inputClass, showErrors && fieldErrors.name && "border-state-danger")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Magill Rd — Unit 4 fitout"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createBlank();
                }}
              />
            </Field>
            <Field label="Reference" help="Optional — your internal job / quote reference." icon={<Hash className="h-4 w-4" />}>
              <input
                className={inputClass}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="e.g. BW-1042"
              />
            </Field>
            <Field label="Site address" help="Optional — you can set this later." icon={<MapPin className="h-4 w-4" />}>
              <input
                className={inputClass}
                value={siteAddress}
                onChange={(e) => setSiteAddress(e.target.value)}
                placeholder="e.g. 12 Magill Rd, Stepney SA 5069"
              />
            </Field>
          </div>

          <div className="mt-5">
            <Button data-testid="create-draft" disabled={!canCreateBlank} onClick={() => void createBlank()} className="w-full">
              {blankSubmitting ? "Creating…" : "Create draft & open builder →"}
            </Button>
          </div>
        </section>

        {/* Start from a blueprint */}
        <section
          className="rounded-card border border-border bg-surface p-5"
          data-testid="new-job-blueprint"
          aria-labelledby="new-job-blueprint-title"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-card bg-brand-navy text-accent-yellow">
                <LayoutTemplate className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="new-job-blueprint-title" className="font-display text-lg font-bold text-brand-navy">
                  Start from a template
                </h2>
                <p className="text-xs text-text-muted">Pre-filled structure you review</p>
              </div>
            </div>
            <Pill tone="neutral">Repeatable work</Pill>
          </div>

          {bpLoadError ? (
            <p className="mt-4 text-sm text-text-muted">
              Couldn&rsquo;t load templates ({bpLoadError}). The blank path still works.
            </p>
          ) : blueprints === null ? (
            <p className="mt-4 text-sm text-text-muted" role="status">
              Loading templates…
            </p>
          ) : blueprints.length === 0 ? (
            <p className="mt-4 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-6 text-center text-sm text-text-muted">
              No saved templates yet. Save one from a finished job&rsquo;s Publish step, then repeat
              work starts here.
            </p>
          ) : (
            <>
              {bpError ? (
                <p role="alert" className="mt-4 rounded-card border border-state-danger bg-rose-50 px-3 py-2 text-sm text-state-danger">
                  {bpError}
                </p>
              ) : null}
              <ul className="mt-4 space-y-2">
                {blueprints.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(b.id)}
                      aria-current={b.id === selectedId ? "true" : undefined}
                      data-testid="blueprint-option"
                      className={cn(
                        "w-full rounded-card border px-3 py-2.5 text-left transition-colors",
                        b.id === selectedId
                          ? "border-brand-navy bg-surface-subtle"
                          : "border-border hover:border-border-strong hover:bg-surface-subtle",
                      )}
                    >
                      <span className="block font-medium text-text">{b.name}</span>
                      <span className="block font-mono text-[11px] text-text-muted">{blueprintSummaryLine(b)}</span>
                      {b.description ? (
                        <span className="mt-0.5 block text-xs text-text-muted">{b.description}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>

              {selected ? (
                <div className="mt-3 space-y-2 rounded-card border border-border p-3">
                  <Field label="New job name" help={`Defaults to “${selected.name}”.`}>
                    <input
                      value={bpName}
                      onChange={(e) => setBpName(e.target.value)}
                      placeholder={selected.name}
                      className={inputClass}
                      data-testid="blueprint-job-name"
                    />
                  </Field>
                  <Button
                    onClick={() => void createFromBlueprint()}
                    disabled={bpSubmitting || (bpName.trim() === "" && selected.name.trim() === "")}
                    data-testid="blueprint-create"
                    className="w-full"
                  >
                    {bpSubmitting ? "Creating…" : "Create draft from template →"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      <div className="mt-6">
        <Link
          href={"/v2/jobs" as Route}
          className="text-sm text-text-muted underline decoration-border underline-offset-4 hover:text-text"
        >
          ← Back to jobs
        </Link>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-border-strong";

function Field({
  label,
  required,
  help,
  error,
  icon,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
        {icon ? <span className="text-text-muted" aria-hidden="true">{icon}</span> : null}
        {label}
        {required ? <span className="ml-0.5 text-state-danger">*</span> : null}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-state-danger">{error}</span>
      ) : help ? (
        <span className="mt-1 block text-[11px] text-text-muted">{help}</span>
      ) : null}
    </label>
  );
}
