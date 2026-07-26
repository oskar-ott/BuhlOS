"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { createJob } from "@/domains/jobs/client";
import {
  blueprintSummaryLine,
  instantiateBlueprint,
  listBlueprints,
  type JobBlueprint,
} from "@/domains/jobs/blueprints";

/**
 * "Start from template" (#191) — the repeat-work shortcut on /v2/jobs/new.
 * Pick a saved blueprint, name the new job, and one POST creates a DRAFT
 * pre-filled with the blueprint's structure (modules, groups, areas, task
 * lists). Routes straight into the builder. Never blocks the blank-draft
 * path below it — an honest empty state when no blueprints exist.
 *
 * Copy semantics: the new job is a COPY — editing it never touches the
 * blueprint, deleting the blueprint never touches the job.
 */
export function StartFromBlueprintCard() {
  const router = useRouter();
  const [blueprints, setBlueprints] = useState<JobBlueprint[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listBlueprints();
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.error.message);
        setBlueprints([]);
        return;
      }
      setBlueprints(res.data.blueprints);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hidden entirely until we know there's at least one — keeps the new-job
  // page clean for companies that haven't saved any templates yet.
  if (blueprints !== null && blueprints.length === 0 && !loadError) return null;

  const selected = blueprints?.find((b) => b.id === selectedId) ?? null;

  async function create() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    const res = await createJob(instantiateBlueprint(selected, name || selected.name));
    if (!res.ok) {
      setSubmitting(false);
      setError(res.error.message);
      return;
    }
    router.push(`/v2/jobs/${encodeURIComponent(res.data.job.id)}/builder` as Route);
  }

  return (
    <Card data-testid="start-from-blueprint">
      <CardTitle>Start from a template</CardTitle>
      <CardDescription className="mt-1">
        Repeat work? Pick a saved job shape — structure, areas and task lists
        come pre-filled. You tweak and publish. (It&rsquo;s a copy — the
        template stays put.)
      </CardDescription>

      {loadError ? (
        <p className="mt-3 text-sm text-text-muted">
          Couldn&rsquo;t load templates ({loadError}). The blank draft below
          still works.
        </p>
      ) : blueprints === null ? (
        <p className="mt-3 text-sm text-text-muted">Loading templates…</p>
      ) : (
        <>
          {error ? (
            <p role="alert" className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {error}
            </p>
          ) : null}
          <ul className="mt-3 space-y-2">
            {blueprints.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(b.id)}
                  aria-current={b.id === selectedId ? "true" : undefined}
                  data-testid="blueprint-option"
                  className={`w-full rounded-card border px-3 py-2.5 text-left transition-colors ${
                    b.id === selectedId
                      ? "border-brand-navy bg-surface-subtle"
                      : "border-border hover:border-border-strong hover:bg-surface-subtle"
                  }`}
                >
                  <span className="block font-medium text-text">{b.name}</span>
                  <span className="block font-mono text-[11px] text-text-muted">
                    {blueprintSummaryLine(b)}
                  </span>
                  {b.description ? (
                    <span className="mt-0.5 block text-xs text-text-muted">{b.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <div className="mt-3 space-y-2 rounded-card border border-border p-3">
              <label className="block">
                <span className="mb-1.5 block font-display text-[13px] font-semibold text-text">
                  New job name
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={selected.name}
                  className="h-11 w-full rounded-card border border-border bg-surface px-3 text-sm outline-none focus:border-border-strong"
                  data-testid="blueprint-job-name"
                />
              </label>
              <Button
                onClick={create}
                disabled={submitting || (name.trim() === "" && selected.name.trim() === "")}
                data-testid="blueprint-create"
              >
                {submitting ? "Creating…" : "Create draft from template →"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
