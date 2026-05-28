"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import { EmployeeStatusChip } from "./EmployeeStatusChip";
import { AddEmployeeDrawer, type ActiveJobOption } from "./AddEmployeeDrawer";
import { EmployeeDetailDrawer } from "./EmployeeDetailDrawer";
import {
  filterEmployees,
  filterCounts,
  displayNameFor,
  displayRoleLabel,
  initialsFor,
} from "@/domains/employees/service";
import { lastActiveLabel } from "@/domains/employees/format";
import type { EmployeeFilterKey, EmployeeRow } from "@/domains/employees/types";

interface EmployeeRegisterClientProps {
  initialRows: ReadonlyArray<EmployeeRow>;
  emailConfigured: boolean;
  activeJobs: ReadonlyArray<ActiveJobOption>;
  /** Deep-link: open this employee's detail drawer on mount (/employees/[id]). */
  initialSelectedId?: string | null;
}

const FILTERS: { key: EmployeeFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "invited", label: "Invited" },
  { key: "incomplete", label: "Incomplete" },
  { key: "field", label: "Field" },
  { key: "admin", label: "Admin" },
  { key: "disabled", label: "Disabled" },
];

export function EmployeeRegisterClient({
  initialRows,
  emailConfigured,
  activeJobs,
  initialSelectedId,
}: EmployeeRegisterClientProps) {
  const [rows, setRows] = useState<EmployeeRow[]>([...initialRows]);
  const [filter, setFilter] = useState<EmployeeFilterKey>("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);

  const counts = useMemo(() => filterCounts(rows), [rows]);
  const visible = useMemo(() => filterEmployees(rows, filter, search), [rows, filter, search]);
  const selected = useMemo(() => rows.find((r) => r.employee.id === selectedId) ?? null, [rows, selectedId]);

  function upsert(row: EmployeeRow) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.employee.id === row.employee.id);
      if (idx === -1) return [row, ...prev];
      const next = [...prev];
      next[idx] = row;
      return next;
    });
  }

  const isEmpty = rows.length === 0;

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-2">
          <Search aria-hidden="true" className="h-4 w-4 text-text-muted" />
          <input
            className="h-9 w-56 bg-transparent text-sm outline-none"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search employees"
          />
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add employee
        </Button>
      </div>

      {/* Filter bar */}
      {!isEmpty ? (
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            const count = counts[f.key];
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-pill border px-3 py-1 font-mono text-[10.5px] uppercase tracking-wider transition-colors",
                  active
                    ? "border-brand-navy bg-brand-navy text-text-inverse"
                    : "border-border bg-surface text-text-muted hover:bg-surface-subtle"
                )}
              >
                {f.label}
                <span className={cn("rounded-pill px-1.5 font-semibold", active ? "bg-accent-yellow text-brand-navy" : "bg-surface-subtle text-text")}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Register */}
      {isEmpty ? (
        <EmptyState
          title="No employees yet"
          description="Add your first employee to start using Phil for hours, gear and jobs."
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add employee
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          {/* Column header */}
          <div className="grid grid-cols-[1.6fr_1fr_0.9fr_0.5fr_0.5fr_0.8fr] gap-3 border-b border-border bg-surface-subtle px-4 py-2 font-mono text-[9.5px] uppercase tracking-wider text-text-muted">
            <span>Employee</span>
            <span>Role</span>
            <span>Status</span>
            <span>Jobs</span>
            <span>Gear</span>
            <span>Last active</span>
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-text-muted">
              No employees match this filter.
            </p>
          ) : (
            <ul>
              {visible.map((row) => {
                const e = row.employee;
                const apprentice = e.role === "apprentice" && e.apprenticeYear ? ` · Y${e.apprenticeYear}` : "";
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(e.id)}
                      className="grid w-full grid-cols-[1.6fr_1fr_0.9fr_0.5fr_0.5fr_0.8fr] items-center gap-3 border-b border-border px-4 py-3 text-left text-sm last:border-b-0 hover:bg-surface-subtle"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-subtle font-mono text-[10px] font-bold text-brand-navy">
                          {initialsFor(e)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-display text-text">{displayNameFor(e)}</span>
                          <span className="block truncate font-mono text-[11px] text-text-muted">{e.email || "—"}</span>
                        </span>
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-text">{displayRoleLabel(e.role)}{apprentice}</span>
                        <span className="block font-mono text-[10px] uppercase tracking-wider text-text-muted">
                          {e.appAccess === "phil" ? "Field · Phil" : e.appAccess === "both" ? "Field · Phil +" : "Office · BuhlOS"}
                        </span>
                      </span>
                      <span><EmployeeStatusChip employee={e} invite={row.invite} /></span>
                      <span className="font-mono tabular-nums text-text">{row.jobsCount || "—"}</span>
                      <span className="font-mono tabular-nums text-text">{row.gearCount || "—"}</span>
                      <span className="font-mono text-[11px] text-text-muted">{lastActiveLabel(e.lastActiveAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <AddEmployeeDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        activeJobs={activeJobs}
        emailConfigured={emailConfigured}
        onCreated={(row) => upsert(row)}
      />
      <EmployeeDetailDrawer
        row={selected}
        emailConfigured={emailConfigured}
        onClose={() => setSelectedId(null)}
        onUpdated={(row) => upsert(row)}
      />
    </div>
  );
}
