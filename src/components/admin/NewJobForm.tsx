"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { createJob } from "@/domains/jobs/client";
import { buildCreatePayload } from "@/domains/jobs/builder";
import { validateJobBasics } from "@/domains/jobs/validate";
import { cn } from "@/lib/cn";

/**
 * New-job create form (admin only — POST /api/jobs is admin-gated).
 *
 * A new job is created as a DRAFT (office-only, invisible to the field)
 * with just the essentials; everything else is filled in afterwards in the
 * Builder. On success we route straight into the Builder for that job so
 * the admin keeps building without a detour.
 *
 * Name is the one required field (mirrors the server). Ref + site address
 * are optional conveniences so the draft is recognisable in the jobs list.
 * Job type + client are deliberately NOT here — they need lookup tables and
 * are managed where those tables live; the Builder round-trips them.
 *
 * Cross-ref:
 *   src/domains/jobs/builder.ts buildCreatePayload — status:'draft'
 *   src/domains/jobs/client.ts createJob — safeParse + POST
 *   src/app/v2/jobs/[jobId]/builder/page.tsx — where we land next
 */
export function NewJobForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const fieldErrors = validateJobBasics({ name }, { requireName: true });
  const canSubmit = Object.keys(fieldErrors).length === 0 && !submitting;

  async function submit() {
    setShowErrors(true);
    if (Object.keys(fieldErrors).length > 0) return;
    setSubmitting(true);
    setError(null);
    const res = await createJob(
      buildCreatePayload({
        name,
        ref: ref.trim() || undefined,
        siteAddress: siteAddress.trim() || undefined,
      })
    );
    if (!res.ok) {
      setSubmitting(false);
      setError(res.error.message);
      return;
    }
    // Keep `submitting` true through the navigation so the button can't be
    // double-fired while the route transition runs.
    router.push(`/v2/jobs/${encodeURIComponent(res.data.job.id)}/builder` as Route);
  }

  return (
    <Card>
      <CardTitle>New job</CardTitle>
      <CardDescription className="mt-1">
        Creates a draft. Drafts are office-only — they stay invisible to the field until you publish
        from the Builder.
      </CardDescription>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        <Field label="Job name" required error={showErrors ? fieldErrors.name : undefined}>
          <input
            data-testid="job-name"
            autoFocus
            className={cn(inputClass, showErrors && fieldErrors.name && "border-rose-400")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Magill Rd — Unit 4 fitout"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </Field>
        <Field label="Reference" help="Optional — your job number or ServiceM8 ref.">
          <input
            className={inputClass}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. BW-1042"
          />
        </Field>
        <Field label="Site address" help="Optional — you can set this later.">
          <input
            className={inputClass}
            value={siteAddress}
            onChange={(e) => setSiteAddress(e.target.value)}
            placeholder="e.g. 12 Magill Rd, Stepney SA 5069"
          />
        </Field>
      </div>

      <div className="mt-5 flex items-center justify-between gap-2">
        <Link
          href={"/v2/jobs" as Route}
          className="text-sm text-text-muted underline decoration-border underline-offset-4 hover:text-text"
        >
          Cancel
        </Link>
        <Button data-testid="create-draft" disabled={!canSubmit} onClick={submit}>
          {submitting ? "Creating…" : "Create draft →"}
        </Button>
      </div>
    </Card>
  );
}

const inputClass =
  "w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-border-strong";

function Field({
  label,
  required,
  help,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-rose-600">{error}</span>
      ) : help ? (
        <span className="mt-1 block text-[11px] text-text-muted">{help}</span>
      ) : null}
    </label>
  );
}
