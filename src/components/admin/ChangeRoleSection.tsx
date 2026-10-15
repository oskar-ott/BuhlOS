"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { changeEmployeeRole, errorText } from "@/domains/employees/client";
import { ROLE_DEFS, ROLE_ORDER } from "@/domains/employees/roles";
import type { EmployeeRole, EmployeeRow } from "@/domains/employees/types";

/**
 * "Role" inside the employee detail drawer — the office's way to move someone
 * between roles (owner pull 2026-10-15: an electrician becoming the project
 * manager had no way to get there; the drawer only displayed the role).
 *
 * Posts POST /api/employees?action=role, which writes BOTH halves of the
 * person: the users.json login every permission check reads, and the linked
 * HR row the roster shows — so the roster can never say "Project manager"
 * over a login that is still an electrician. Non-optimistic: the drawer only
 * shows the new role once the server confirms it.
 *
 * The person's next app open picks the new role up on its own (role-change
 * sync, src/lib/auth/role-sync.ts) — no signing out — and the copy says so.
 */

interface ChangeRoleSectionProps {
  employee: EmployeeRow["employee"];
  onUpdated: (row: EmployeeRow) => void;
  /** Start with the picker open (render tests only). */
  defaultOpen?: boolean;
}

export function ChangeRoleSection({ employee, onUpdated, defaultOpen = false }: ChangeRoleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [role, setRole] = useState<EmployeeRole>(employee.role);
  const [apprenticeYear, setApprenticeYear] = useState<number | null>(employee.apprenticeYear ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedTo, setChangedTo] = useState<EmployeeRole | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- apprenticeYear belongs to the literal apprentice role, not a tier
  const needsYear = role === "apprentice";
  const unchanged = role === employee.role && (!needsYear || apprenticeYear === employee.apprenticeYear);
  const canSave = !busy && !unchanged && (!needsYear || apprenticeYear != null);

  function openPicker() {
    setRole(employee.role);
    setApprenticeYear(employee.apprenticeYear ?? null);
    setError(null);
    setChangedTo(null);
    setOpen(true);
  }

  function cancel() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const res = await changeEmployeeRole({
      id: employee.id,
      role,
      apprenticeYear: needsYear ? apprenticeYear : null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    onUpdated(res.data.row);
    setOpen(false);
    setChangedTo(role);
  }

  return (
    <section>
      <h3 className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-text-muted">Role</h3>

      {changedTo ? (
        <p
          data-testid="change-role-updated"
          className="mb-2 rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
        >
          {employee.firstName} is now {ROLE_DEFS[changedTo].title.toLowerCase()}. They&rsquo;ll see their
          new screens next time they open the app.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mb-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </p>
      ) : null}

      {!open ? (
        <div className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2">
          <p className="text-xs text-text-muted">
            {ROLE_DEFS[employee.role].title} · {ROLE_DEFS[employee.role].surfaceLabel}
          </p>
          <Button size="sm" variant="secondary" onClick={openPicker} data-testid="change-role-open">
            Change role
          </Button>
        </div>
      ) : (
        <div data-testid="change-role-form" className="space-y-2 rounded-card border border-border bg-surface px-3 py-2">
          <div className="grid grid-cols-1 gap-1.5">
            {ROLE_ORDER.map((id) => {
              const def = ROLE_DEFS[id];
              const selected = role === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => setRole(id)}
                  className={cn(
                    "rounded-card border px-3 py-2 text-left transition-colors",
                    selected ? "border-brand-navy bg-surface-subtle" : "border-border hover:bg-surface-subtle",
                  )}
                >
                  <span className="block font-display text-sm text-text">
                    {def.title}
                    {id === employee.role ? <span className="text-text-muted"> · current</span> : null}
                  </span>
                  <span className="block text-xs text-text-muted">{def.surfaceLabel}</span>
                </button>
              );
            })}
          </div>

          {needsYear ? (
            <div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Apprentice year</span>
              <div className="mt-1 flex gap-2">
                {[1, 2, 3, 4].map((y) => (
                  <button
                    key={y}
                    type="button"
                    aria-pressed={apprenticeYear === y}
                    disabled={busy}
                    onClick={() => setApprenticeYear(y)}
                    className={cn(
                      "h-9 w-12 rounded-card border text-sm",
                      apprenticeYear === y ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border",
                    )}
                  >
                    Y{y}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <p className="text-xs text-text-muted">
            Their hours, jobs and sign-in stay as they are. {employee.firstName} sees the change next
            time they open the app.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!canSave} data-testid="change-role-save">
              {busy ? "Saving…" : "Save role"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
