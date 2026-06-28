"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import type {
  CloseoutLinkOption,
  CloseoutMatrixView,
  CloseoutRequirementView,
} from "@/server/job-control/closeout-read";
import type { CloseoutFulfilmentLink } from "@/domains/job-control/types";
import {
  CLOSEOUT_AUTHOR_KINDS,
  CLOSEOUT_KIND_LABEL,
  buildAddOp,
  buildLinkOp,
  linkOptionKey,
  parseLinkOptionKey,
  type CloseoutAuthorKind,
} from "./closeout-ops";

/**
 * Closeout matrix authoring panel (#374) — the admin click-path on
 * /v2/jobs/[jobId]/closeout. Renders the requirements matrix (status, links,
 * confirmation) and the full author surface: ADD a requirement (title + kind),
 * LINK a real record (the picker only offers live certificate / document /
 * as-built / ITP / evidence ids — never a fabricated option), and the
 * per-requirement actions confirm / un-confirm, waive / un-waive, remove. Each
 * action POSTs one op to /api/job-control/closeout/confirm (HMAC admin-gated)
 * with the artifact `revision` as the stale-write precondition, then refreshes
 * the server-rendered page so the re-derived status is authoritative.
 *
 * Read-only with respect to job completion — nothing here freezes or gates the
 * job's close-out (#349 owns that).
 *
 * The status shown is whatever the server re-derived (links + confirmation +
 * live ids); the panel never invents a "satisfied" client-side.
 */

type Busy = { id: string; op: string } | null;

export function CloseoutMatrixPanel({
  jobId,
  view,
}: {
  jobId: string;
  view: CloseoutMatrixView;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  if (!view.ok) {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>Couldn&rsquo;t read the closeout matrix</CardTitle>
        <CardDescription className="text-amber-900">Try again in a moment.</CardDescription>
      </Card>
    );
  }

  if (view.status === "missing") {
    return (
      <Card>
        <CardTitle>Nothing to close out yet</CardTitle>
        <CardDescription className="mt-2">
          This job has no compiled job-control spine, so there are no closeout
          obligations to track. Reconcile and compile the job first.
        </CardDescription>
      </Card>
    );
  }

  if (view.status === "unreadable") {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>The job-control spine is unreadable</CardTitle>
        <CardDescription className="text-amber-900">
          Inspect or restore it before tracking closeout.
        </CardDescription>
      </Card>
    );
  }

  const { counts, requirements, revision, linkOptions } = view;

  async function runOp(op: Record<string, unknown>, key: { id: string; op: string }) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/job-control/closeout/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ jobId, expectedJobControlRevision: revision, op }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (!res.ok) {
        setError(
          body.reason === "stale_revision"
            ? "This page is out of date — refresh and try again."
            : body.error ?? body.reason ?? `Save failed (${res.status}).`,
        );
        setBusy(null);
        return;
      }
      // Re-render the server component so the re-derived status is authoritative.
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  const isEmpty = counts.total === 0;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Closeout readiness</CardTitle>
            <CardDescription className="mt-1">
              Read-only on completion — this tracks handover obligations, it
              doesn&rsquo;t freeze the job.
            </CardDescription>
          </div>
          {isEmpty ? (
            <Pill tone="neutral" className="shrink-0 font-semibold">
              Nothing to close out yet
            </Pill>
          ) : (
            <Pill
              tone={counts.discharged === counts.total ? "navy" : "warning"}
              className="shrink-0 font-semibold"
            >
              {counts.discharged} of {counts.total} closed out
            </Pill>
          )}
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            {error}
          </p>
        ) : null}
      </Card>

      {isEmpty ? (
        <Card>
          <CardTitle>Nothing to close out yet</CardTitle>
          <CardDescription className="mt-2">
            No closeout obligations on this job yet. Add the first one below — the
            standing electrical defaults are seeded the first time the job&rsquo;s
            scope is compiled.
          </CardDescription>
        </Card>
      ) : (
        <ul className="space-y-2">
          {requirements.map((req) => (
            <RequirementRow
              key={req.id}
              req={req}
              linkOptions={linkOptions}
              busy={busy?.id === req.id ? busy.op : null}
              onConfirm={(confirmed) =>
                runOp({ op: "confirm", requirementId: req.id, confirmed }, { id: req.id, op: "confirm" })
              }
              onWaive={(waived) =>
                runOp({ op: "waive", requirementId: req.id, waived }, { id: req.id, op: "waive" })
              }
              onRemove={() => runOp({ op: "remove", requirementId: req.id }, { id: req.id, op: "remove" })}
              onLink={(links) =>
                runOp(buildLinkOp(req.id, links) as unknown as Record<string, unknown>, {
                  id: req.id,
                  op: "link",
                })
              }
            />
          ))}
        </ul>
      )}

      <AddRequirementForm
        busy={busy?.id === ADD_FORM_KEY ? busy.op : null}
        onAdd={(title, kind) => {
          const op = buildAddOp(title, kind);
          if (!op) return;
          runOp(op as unknown as Record<string, unknown>, { id: ADD_FORM_KEY, op: "add" });
        }}
      />
    </div>
  );
}

/** Sentinel busy-key for the add form (no requirement id of its own). */
const ADD_FORM_KEY = "__add__";

function AddRequirementForm({
  busy,
  onAdd,
}: {
  busy: string | null;
  onAdd: (title: string, kind: CloseoutAuthorKind) => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<CloseoutAuthorKind>("document");
  const adding = busy === "add";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (title.trim().length === 0) return;
    onAdd(title, kind);
    setTitle("");
  }

  return (
    <Card>
      <CardTitle>Add a requirement</CardTitle>
      <CardDescription className="mt-1">
        A handover obligation specific to this job (the standing electrical
        defaults are seeded at compile — add anything beyond them here).
      </CardDescription>
      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-[14rem] flex-1 text-sm">
          <span className="mb-1 block font-medium text-slate-700">What must be done</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. RCD test schedule handed to the builder"
            aria-label="Requirement title"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CloseoutAuthorKind)}
            aria-label="Requirement kind"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            {CLOSEOUT_AUTHOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {CLOSEOUT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" variant="primary" disabled={adding || title.trim().length === 0}>
          {adding ? "Adding…" : "Add requirement"}
        </Button>
      </form>
    </Card>
  );
}

const STATUS_TONE: Record<string, "navy" | "warning" | "neutral"> = {
  satisfied: "navy",
  waived: "neutral",
  in_progress: "warning",
  outstanding: "warning",
};
const STATUS_LABEL: Record<string, string> = {
  satisfied: "Closed out",
  waived: "Waived",
  in_progress: "In progress",
  outstanding: "Outstanding",
};

function RequirementRow({
  req,
  linkOptions,
  busy,
  onConfirm,
  onWaive,
  onRemove,
  onLink,
}: {
  req: CloseoutRequirementView;
  linkOptions: CloseoutLinkOption[];
  busy: string | null;
  onConfirm: (confirmed: boolean) => void;
  onWaive: (waived: boolean) => void;
  onRemove: () => void;
  onLink: (links: CloseoutFulfilmentLink[]) => void;
}) {
  const confirmed = Boolean(req.confirmedAt);
  const waived = req.status === "waived";
  const anyBusy = busy != null;

  // Current links keyed for set membership; options not already attached.
  const attachedKeys = useMemo(
    () => new Set(req.links.map((l) => linkOptionKey(l))),
    [req.links],
  );
  const available = useMemo(
    () => linkOptions.filter((o) => !attachedKeys.has(linkOptionKey(o))),
    [linkOptions, attachedKeys],
  );
  const [pick, setPick] = useState("");

  function attach() {
    const parsed = parseLinkOptionKey(pick);
    if (!parsed) return;
    // link op REPLACES the array → send existing + the newly-picked record.
    onLink([...req.links.map((l) => ({ type: l.type, id: l.id })), parsed]);
    setPick("");
  }
  function detach(key: string) {
    onLink(req.links.filter((l) => linkOptionKey(l) !== key).map((l) => ({ type: l.type, id: l.id })));
  }

  return (
    <li className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block font-display text-base font-semibold text-text">{req.title}</span>
          <span className="mt-0.5 block text-xs text-text-muted">
            {req.source === "clause" ? "From scope" : "Standing obligation"} · {req.kind}
            {req.links.length > 0
              ? ` · ${req.links.filter((l) => l.resolved).length}/${req.links.length} link${
                  req.links.length === 1 ? "" : "s"
                } resolve`
              : " · no linked record"}
          </span>
          {req.hasDanglingLink ? (
            <span className="mt-0.5 block text-xs text-amber-700">
              A linked record is missing — re-link before sign-off.
            </span>
          ) : null}
        </div>
        <Pill tone={STATUS_TONE[req.status] ?? "neutral"} className="shrink-0">
          {STATUS_LABEL[req.status] ?? req.status}
        </Pill>
      </div>

      {req.links.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {req.links.map((l) => {
            const key = linkOptionKey(l);
            const label = linkOptions.find((o) => linkOptionKey(o) === key)?.label ?? l.id;
            return (
              <li key={key} className="flex items-center gap-2 text-xs">
                <span
                  className={
                    l.resolved
                      ? "inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800"
                      : "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800"
                  }
                >
                  {l.type}
                </span>
                <span className="min-w-0 truncate text-text">{label}</span>
                {!l.resolved ? <span className="text-amber-700">missing</span> : null}
                <button
                  type="button"
                  disabled={anyBusy}
                  onClick={() => detach(key)}
                  className="ml-auto text-text-muted underline decoration-dotted disabled:opacity-50"
                >
                  Unlink
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {available.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`link-${req.id}`}>
            Link a record to {req.title}
          </label>
          <select
            id={`link-${req.id}`}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            aria-label="Link a record"
            className="rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          >
            <option value="">Link a record…</option>
            {available.map((o) => {
              const key = linkOptionKey(o);
              return (
                <option key={key} value={key}>
                  {o.type}: {o.label}
                </option>
              );
            })}
          </select>
          <Button size="sm" variant="secondary" disabled={anyBusy || pick === ""} onClick={attach}>
            {busy === "link" ? "Linking…" : "Link"}
          </Button>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {!waived ? (
          <Button
            size="sm"
            variant={confirmed ? "secondary" : "primary"}
            disabled={anyBusy}
            onClick={() => onConfirm(!confirmed)}
          >
            {busy === "confirm" ? "Saving…" : confirmed ? "Un-confirm" : "Confirm"}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => onWaive(!waived)}>
          {busy === "waive" ? "Saving…" : waived ? "Un-waive" : "Waive"}
        </Button>
        <Button size="sm" variant="ghost" disabled={anyBusy} onClick={onRemove}>
          {busy === "remove" ? "Removing…" : "Remove"}
        </Button>
      </div>
    </li>
  );
}
