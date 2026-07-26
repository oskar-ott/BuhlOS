"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Plus, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import { EmployeeStatusChip } from "./EmployeeStatusChip";
import { AddEmployeeDrawer, type ActiveJobOption } from "./AddEmployeeDrawer";
import { EmployeeDetailDrawer } from "./EmployeeDetailDrawer";
import { RecentItemTracker } from "./RecentItemTracker";
import {
  filterEmployees,
  filterCounts,
  displayNameFor,
  displayRoleLabel,
  initialsFor,
} from "@/domains/employees/service";
import type { EmployeeFilterKey, EmployeeRow } from "@/domains/employees/types";

interface EmployeeRegisterClientProps {
  initialRows: ReadonlyArray<EmployeeRow>;
  emailConfigured: boolean;
  activeJobs: ReadonlyArray<ActiveJobOption>;
  /** Deep-link: open this employee's detail drawer on mount (/employees/[id]). */
  initialSelectedId?: string | null;
  /** #331: worst licence status per worker ACCOUNT id (renewal-aware,
   *  server-computed). Drives the row warning chip + the needs-attention
   *  toggle. Empty map = chips hidden (fail-soft). */
  licenceStatusByUserId?: Readonly<Record<string, "expired" | "expiring" | "ok">>;
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

/**
 * Employee register — lean-reset re-skin (replica lines 429-442): one card,
 * "Employee register" head + navy "Add worker" button, then one row per worker
 * (navy initials avatar · name · role + mobile · status pills · chevron).
 * Search, the filter pills and the licence-attention toggle are EXISTING
 * behaviour the replica doesn't show — kept, restyled to sit inside the card.
 * Everything else (drawers, deep-link, recents) is unchanged behaviour.
 */
export function EmployeeRegisterClient({
  initialRows,
  emailConfigured,
  activeJobs,
  initialSelectedId,
  licenceStatusByUserId = {},
}: EmployeeRegisterClientProps) {
  const [rows, setRows] = useState<EmployeeRow[]>([...initialRows]);
  const [filter, setFilter] = useState<EmployeeFilterKey>("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [licenceAttentionOnly, setLicenceAttentionOnly] = useState(false);

  const licenceFlagFor = (row: EmployeeRow): "expired" | "expiring" | null => {
    const userId = row.employee.userId;
    if (!userId) return null;
    const worst = licenceStatusByUserId[userId];
    return worst === "expired" || worst === "expiring" ? worst : null;
  };
  const licenceAttentionCount = useMemo(
    () => rows.filter((r) => licenceFlagFor(r) !== null).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- licenceStatusByUserId is server-load stable
    [rows, licenceStatusByUserId]
  );

  const counts = useMemo(() => filterCounts(rows), [rows]);
  const visible = useMemo(() => {
    const base = filterEmployees(rows, filter, search);
    return licenceAttentionOnly ? base.filter((r) => licenceFlagFor(r) !== null) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- licenceFlagFor derives from stable server data
  }, [rows, filter, search, licenceAttentionOnly, licenceStatusByUserId]);
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
      {/* #215 — when a worker is deep-linked open (/employees/[id]), record the
          visit in the device-local recents ring buffer so ⌘K can offer a
          one-keystroke jump back. Renders nothing; uses the resolved row so the
          label is the worker's real display name. */}
      {selected ? (
        <RecentItemTracker
          path={`/employees/${selected.employee.id}`}
          title={displayNameFor(selected.employee)}
          type="employee"
        />
      ) : null}

      {isEmpty ? (
        <EmptyState
          title="No workers yet"
          description="Add your first worker to start using BuhlOS for hours, gear and jobs."
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add worker
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface-raised shadow-card">
          {/* Card head — replica line 430. */}
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <h2 className="font-display text-base text-text">Employee register</h2>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add worker
            </Button>
          </div>

          {/* Search + filters — existing behaviour, restyled into the card. */}
          <div className="space-y-2.5 border-b border-border px-4 py-3 sm:px-5">
            <div className="flex w-full items-center gap-2 rounded-card border border-border bg-surface px-2 sm:w-72">
              <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                className="h-9 w-full bg-transparent text-sm outline-none"
                placeholder="Search name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search employees"
              />
            </div>
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
              {licenceAttentionCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setLicenceAttentionOnly((v) => !v)}
                  data-testid="licence-attention-toggle"
                  className={cn(
                    "flex items-center gap-1.5 rounded-pill border px-3 py-1 font-mono text-[10.5px] uppercase tracking-wider transition-colors",
                    licenceAttentionOnly
                      ? "border-state-danger bg-state-danger text-text-inverse"
                      : "border-state-danger-subtle-border bg-state-danger-subtle-bg text-state-danger-subtle-text hover:opacity-90"
                  )}
                >
                  <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />
                  Licences to watch
                  <span className={cn("rounded-pill px-1.5 font-semibold", licenceAttentionOnly ? "bg-accent-yellow text-brand-navy" : "bg-surface text-state-danger-subtle-text")}>
                    {licenceAttentionCount}
                  </span>
                </button>
              ) : null}
            </div>
          </div>

          {/* Register rows — replica lines 431-441: avatar · name · role +
              mobile · licence pill · status pill · chevron. Email stands in on
              the sub-line when no mobile is on file (never a fake number);
              jobs/gear/last-active moved to the detail drawer. */}
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-text-muted">
              No employees match this filter.
            </p>
          ) : (
            <ul>
              {visible.map((row) => {
                const e = row.employee;
                // eslint-disable-next-line no-restricted-syntax -- apprenticeYear belongs to the literal apprentice role, not a tier
                const apprentice = e.role === "apprentice" && e.apprenticeYear ? ` · Y${e.apprenticeYear}` : "";
                const flag = licenceFlagFor(row);
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(e.id)}
                      className="flex w-full items-center gap-3.5 border-b border-border px-4 py-3.5 text-left last:border-b-0 hover:bg-surface-subtle sm:px-5"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-navy font-display text-[13px] font-semibold text-text-inverse">
                        {initialsFor(e)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-[15px] font-semibold text-text">
                          {displayNameFor(e)}
                        </span>
                        <span className="block truncate text-[13px] text-text-muted">
                          {displayRoleLabel(e.role)}
                          {apprentice} · {e.phone || e.email || "—"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {flag ? (
                          <span
                            className={cn(
                              "rounded-pill border px-2 py-0.5 text-[11px] font-semibold",
                              flag === "expired"
                                ? "border-state-danger-subtle-border bg-state-danger-subtle-bg text-state-danger-subtle-text"
                                : "border-state-warning-subtle-border bg-state-warning-subtle-bg text-state-warning-subtle-text"
                            )}
                          >
                            {flag === "expired" ? "Licence expired" : "Licence due soon"}
                          </span>
                        ) : null}
                        <EmployeeStatusChip employee={e} invite={row.invite} />
                        <ChevronRight aria-hidden="true" className="h-4 w-4 text-text-muted" />
                      </span>
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
        activeJobs={activeJobs}
        onClose={() => setSelectedId(null)}
        onUpdated={(row) => upsert(row)}
      />
    </div>
  );
}
