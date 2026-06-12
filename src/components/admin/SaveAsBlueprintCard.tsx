"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { captureBlueprint } from "@/domains/jobs/blueprints";

/**
 * "Save as template" (#191) — capture THIS job's reusable shape as a global
 * blueprint, so the next repeat job starts pre-filled. Lives on the builder's
 * Publish tab (the job's shape is settled by then).
 *
 * Capture is server-side and copies STRUCTURE ONLY — modules, area groups,
 * areas and the default task lists. It deliberately leaves out this job's
 * site address, client, dates, money and assignment: a template is a
 * cross-site shape, not a copy of this job. The card says so plainly.
 */
export function SaveAsBlueprintCard({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const res = await captureBlueprint({
      jobId,
      name: name.trim(),
      description: description.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setSaved(res.data.blueprint.name);
    setOpen(false);
    setName("");
    setDescription("");
  }

  return (
    <Card>
      <CardTitle>Save as a template</CardTitle>
      <CardDescription className="mt-1">
        Reuse this job&rsquo;s shape next time. Captures structure, areas and
        task lists only — not the site, client, dates or assignment. The next
        job starts from &ldquo;New job → Start from a template&rdquo;.
      </CardDescription>

      {saved ? (
        <p className="mt-3 rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Saved as &ldquo;{saved}&rdquo;. It&rsquo;s a copy — editing this job
          won&rsquo;t change the template.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      ) : null}

      {open ? (
        <div className="mt-4 space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name — e.g. Townhouse unit block"
            className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-border-strong"
            data-testid="blueprint-name"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional) — when to use this shape"
            rows={2}
            className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-border-strong"
          />
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy || name.trim() === ""} data-testid="blueprint-save">
              {busy ? "Saving…" : "Save template"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="blueprint-save-open">
            Save this shape as a template
          </Button>
        </div>
      )}
    </Card>
  );
}
