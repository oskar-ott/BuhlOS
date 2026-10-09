"use client";

import { useEffect, useState } from "react";
import { Briefcase, X } from "lucide-react";
import { searchJobs } from "@/domains/workshop-stock/client";
import type { JobOption } from "@/domains/workshop-stock/schema";

/**
 * Optional job note on a stock movement. Informational only — it never blocks
 * a take and never becomes a job cost (stock was costed when it was bought).
 */
export function JobPicker({ value, onChange, disabled = false }: { value: JobOption | null; onChange: (j: JobOption | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchJobs(q);
      if (!alive) return;
      if (r.ok) { setJobs(r.data.jobs); setFailed(false); } else setFailed(true);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, q]);

  if (value) {
    return (
      <div className="flex min-h-[48px] items-center gap-2 rounded-card border border-border px-3" data-testid="stock-job-chosen">
        <Briefcase aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm text-text">For {value.code ? `${value.code} · ${value.name}` : value.name}</span>
        <button type="button" onClick={() => onChange(null)} disabled={disabled} aria-label="Remove job" className="inline-flex h-11 w-11 items-center justify-center text-text-muted">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} className="inline-flex min-h-[48px] items-center gap-2 text-sm font-semibold text-brand-navy" data-testid="stock-job-open">
        <Briefcase aria-hidden="true" className="h-4 w-4" />
        Note a job (optional)
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-card border border-border p-3">
      <div className="flex items-center gap-2">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Job name or IV number" aria-label="Search jobs" className="h-12 min-w-0 flex-1 rounded-card border border-border-strong bg-surface px-3 text-base" data-testid="stock-job-search" />
        <button type="button" onClick={() => setOpen(false)} className="inline-flex h-12 items-center px-2 text-sm font-semibold text-text-muted">Skip</button>
      </div>
      {failed ? <p className="text-xs text-text-muted">Couldn&rsquo;t load jobs — you can skip this.</p> : null}
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {jobs.map((j) => (
          <li key={j.id}>
            <button type="button" onClick={() => { onChange(j); setOpen(false); }} className="flex min-h-[48px] w-full items-center rounded-card px-2 text-left text-sm text-text hover:bg-surface-subtle" data-testid="stock-job-option">
              {j.code ? <span className="mr-2 font-mono text-xs text-text-muted">{j.code}</span> : null}
              <span className="truncate">{j.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
