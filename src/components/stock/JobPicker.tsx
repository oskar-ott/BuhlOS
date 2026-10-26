"use client";

import { useEffect, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { searchJobs } from "@/domains/workshop-stock/client";
import type { JobOption } from "@/domains/workshop-stock/schema";

/**
 * Optional job note on a stock movement. Informational only — it never blocks
 * a take and never becomes a job cost (stock was costed when it was bought) —
 * and it says so every time it is shown.
 */
export function JobPicker({ value, onChange, disabled = false, label = "Note a job" }: { value: JobOption | null; onChange: (j: JobOption | null) => void; disabled?: boolean; label?: string }) {
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
      <div className="rounded-xl border border-border px-3 py-2" data-testid="stock-job-chosen">
        <p className="text-[13px] font-semibold text-text">{label} <span className="font-medium text-text-muted">· a note only, not a charge</span></p>
        <div className="flex min-h-[40px] items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">{value.code ? `${value.code} · ${value.name}` : value.name}</span>
          <button type="button" onClick={() => onChange(null)} disabled={disabled} aria-label="Remove job" className="inline-flex h-11 items-center gap-1 px-2 text-sm font-semibold text-state-info">
            Change <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} className="flex min-h-[48px] w-full items-center justify-between rounded-xl border border-border bg-surface-subtle px-3.5 text-left text-[15px] font-semibold text-brand-navy disabled:opacity-60" data-testid="stock-job-open">
        <span>
          {label} <span className="font-medium text-text-muted">(optional · not a charge)</span>
        </span>
        <ChevronDown aria-hidden="true" className="h-5 w-5" />
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <p className="text-[13px] font-semibold text-text">{label} <span className="font-medium text-text-muted">· a note only, not a charge</span></p>
      <div className="flex items-center gap-2">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Job name or IV number" aria-label="Search jobs" className="h-12 min-w-0 flex-1 rounded-xl border border-border-strong bg-surface px-3 text-base" data-testid="stock-job-search" />
        <button type="button" onClick={() => setOpen(false)} className="inline-flex h-12 items-center px-2 text-sm font-semibold text-text-muted">Skip</button>
      </div>
      {failed ? <p className="text-xs text-text-muted">Couldn&rsquo;t load jobs — you can skip this.</p> : null}
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {jobs.map((j) => (
          <li key={j.id}>
            <button type="button" onClick={() => { onChange(j); setOpen(false); }} className="flex min-h-[48px] w-full items-center rounded-xl px-2 text-left text-sm text-text hover:bg-surface-subtle" data-testid="stock-job-option">
              {j.code ? <span className="mr-2 font-mono text-xs text-text-muted">{j.code}</span> : null}
              <span className="truncate">{j.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
