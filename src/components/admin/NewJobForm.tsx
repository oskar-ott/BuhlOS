"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import { AddressAutocompleteInput } from "@/components/ui/AddressAutocompleteInput";
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
 * Name and the IV number are required (the server validates the IV format and
 * refuses a duplicate with a 409). Ref + site address are optional
 * conveniences so the draft is recognisable in the jobs list.
 * Job type + client are deliberately NOT here — they need lookup tables and
 * are managed where those tables live; the Builder round-trips them.
 *
 * Cross-ref:
 *   src/domains/jobs/builder.ts buildCreatePayload — status:'draft'
 *   src/domains/jobs/client.ts createJob — safeParse + POST
 *   src/app/v2/jobs/[jobId]/builder/page.tsx — where we land next
 */
/** Server refusals that belong to ONE field, so they render next to it. */
export interface CreateJobFieldErrors {
  name?: string;
  code?: string;
}

/**
 * Map a failed POST /api/jobs to the field it is about. createJob answers a
 * duplicate IV number with a 409 naming the clashing job, and a duplicate name
 * (the job id is slugified from it) with a 400 "job id already exists". Any
 * other failure returns null and stays a form-level error.
 */
export function createJobFieldError(status: number, body: unknown): CreateJobFieldErrors | null {
  const serverMsg =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "";
  if (status === 409) {
    const used = /already used by "([^"]+)"/.exec(serverMsg)?.[1];
    return {
      code: used
        ? `That IV number is already used by “${used}” — pick another.`
        : "That IV number is already in use — pick another.",
    };
  }
  if (status === 400 && /already exists/i.test(serverMsg)) {
    return { name: "A job with this name already exists — use a different name." };
  }
  return null;
}

export function NewJobForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [ref, setRef] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<CreateJobFieldErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // Synchronous in-flight latch: a fast double-Enter fires both keydowns
  // before React re-renders with `submitting`, so state alone can't stop the
  // second create.
  const inFlightRef = useRef(false);

  const fieldErrors: Record<string, string | undefined> = { ...validateJobBasics({ name }, { requireName: true }) };
  // The IV number is what every worker gives the wholesaler and what supplier
  // invoices are matched on — a job without one can never receive a cost.
  const codeTrim = code.trim().toUpperCase();
  if (!codeTrim) fieldErrors.code = "IV number is required";
  else if (!/^IV\d{4}$/.test(codeTrim)) fieldErrors.code = "IV followed by four digits, e.g. IV3232";

  async function submit() {
    if (inFlightRef.current || submitting) return;
    setShowErrors(true);
    // The button stays clickable while the form is invalid: a click reveals
    // the field errors and moves focus to the first one, instead of a dead
    // disabled button that never says why.
    if (fieldErrors.name) {
      nameRef.current?.focus();
      return;
    }
    if (fieldErrors.code) {
      codeRef.current?.focus();
      return;
    }
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    setServerFieldErrors({});
    const res = await createJob(
      buildCreatePayload({
        name,
        code: codeTrim,
        ref: ref.trim() || undefined,
        siteAddress: siteAddress.trim() || undefined,
      })
    );
    if (!res.ok) {
      inFlightRef.current = false;
      setSubmitting(false);
      const perField = createJobFieldError(res.error.status, res.error.body);
      if (perField) {
        setServerFieldErrors(perField);
        (perField.code ? codeRef : nameRef).current?.focus();
        return;
      }
      setError(res.error.message);
      return;
    }
    // Keep `submitting` true through the navigation so the button can't be
    // double-fired while the route transition runs.
    router.push(`/v2/jobs/${encodeURIComponent(res.data.job.id)}/builder` as Route);
  }

  // Client validation shows once the user has tried to create; a server
  // refusal about a field (duplicate IV number / name) shows next to it.
  const nameError = (showErrors ? fieldErrors.name : undefined) ?? serverFieldErrors.name;
  const codeError = (showErrors ? fieldErrors.code : undefined) ?? serverFieldErrors.code;

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
        <Field label="Job name" required error={nameError}>
          <input
            ref={nameRef}
            data-testid="job-name"
            autoFocus
            aria-invalid={nameError ? true : undefined}
            className={cn(inputClass, nameError && "border-rose-400")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (serverFieldErrors.name) setServerFieldErrors((p) => ({ ...p, name: undefined }));
            }}
            placeholder="e.g. Magill Rd — Unit 4 fitout"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </Field>
        <Field
          label="IV number"
          required
          help="The job number workers give the wholesaler — supplier invoices are matched on it."
          error={codeError}
        >
          <input
            ref={codeRef}
            data-testid="job-code"
            aria-invalid={codeError ? true : undefined}
            className={cn(inputClass, "font-mono uppercase", codeError && "border-rose-400")}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (serverFieldErrors.code) setServerFieldErrors((p) => ({ ...p, code: undefined }));
            }}
            placeholder="e.g. IV3232"
            maxLength={8}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
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
        <Field
          label="Site address"
          help="Optional — start typing and pick the address, or set it later."
        >
          <AddressAutocompleteInput
            data-testid="job-site-address"
            className={inputClass}
            value={siteAddress}
            onChange={setSiteAddress}
            placeholder="e.g. 12 Magill Rd, Stepney SA 5069"
          />
        </Field>
      </div>

      {/* Lean-reset replica 368-371: actions right-aligned — ghost Cancel +
          navy Create draft. */}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Link
          href={"/v2/jobs" as Route}
          className="inline-flex h-10 items-center rounded-card border border-border bg-surface px-4 text-sm font-semibold text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          Cancel
        </Link>
        <Button data-testid="create-draft" disabled={submitting} onClick={() => void submit()}>
          {submitting ? "Creating…" : "Create draft →"}
        </Button>
      </div>
    </Card>
  );
}

const inputClass =
  "h-11 w-full rounded-card border border-border bg-surface px-3 text-sm text-text outline-none focus:border-border-strong";

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
      <span className="mb-1.5 block font-display text-[13px] font-semibold text-text">
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
