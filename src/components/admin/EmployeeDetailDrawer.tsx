"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { InviteStatusCard } from "./InviteStatusCard";
import { EmployeeStatusChip } from "./EmployeeStatusChip";
import { cn } from "@/lib/cn";
import { issueInvite, revokeInvite, disableEmployee, errorText } from "@/domains/employees/client";
import { displayNameFor, displayRoleLabel } from "@/domains/employees/service";
import { formatDateTime, formatShortDate } from "@/domains/employees/format";
import type { EmployeeRow } from "@/domains/employees/types";

interface EmployeeDetailDrawerProps {
  row: EmployeeRow | null;
  emailConfigured: boolean;
  onClose: () => void;
  onUpdated: (row: EmployeeRow) => void;
}

export function EmployeeDetailDrawer({
  row,
  emailConfigured,
  onClose,
  onUpdated,
}: EmployeeDetailDrawerProps) {
  const [busy, setBusy] = useState(false);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "revoke" | "disable">(null);
  const [error, setError] = useState<string | null>(null);

  if (!row) return null;
  const { employee, invite } = row;
  const apprentice = employee.role === "apprentice" && employee.apprenticeYear ? ` · Y${employee.apprenticeYear}` : "";

  async function doResend() {
    setBusy(true); setError(null);
    const res = await issueInvite({ id: employee.id });
    setBusy(false);
    if (!res.ok) { setError(errorText(res.error)); return; }
    onUpdated(res.data.row);
    setFreshLink(res.data.inviteLink ? toAbsolute(res.data.inviteLink) : null);
  }

  async function doRevoke() {
    setConfirm(null); setBusy(true); setError(null);
    const res = await revokeInvite(employee.id);
    setBusy(false);
    if (!res.ok) { setError(errorText(res.error)); return; }
    onUpdated(res.data.row); setFreshLink(null);
  }

  async function doDisable() {
    setConfirm(null); setBusy(true); setError(null);
    const res = await disableEmployee({ id: employee.id });
    setBusy(false);
    if (!res.ok) { setError(errorText(res.error)); return; }
    onUpdated(res.data.row);
  }

  return (
    <>
      <Drawer
        open={Boolean(row)}
        onClose={onClose}
        title={displayNameFor(employee)}
        subtitle={`${displayRoleLabel(employee.role)}${apprentice}`}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <EmployeeStatusChip employee={employee} invite={invite} />
          </div>

          {error ? (
            <p className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>
          ) : null}

          {/* Invite timeline (bible A6) */}
          <section>
            <h3 className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-text-muted">Invite timeline</h3>
            <ul className="space-y-1 font-mono text-[11px] text-text-muted">
              <TimelineRow at={employee.createdAt} label="created" />
              {invite?.sentAt ? <TimelineRow at={invite.sentAt} label={`invite sent → ${invite.email}`} /> : null}
              <TimelineRow at={invite?.openedAt} label={invite?.openedAt ? "opened" : "not yet opened"} muted={!invite?.openedAt} />
              {invite?.acceptedAt ? <TimelineRow at={invite.acceptedAt} label="setup complete" /> : null}
              {invite?.revokedAt ? <TimelineRow at={invite.revokedAt} label="revoked" /> : null}
              {invite?.expiresAt && invite.status !== "accepted" ? (
                <li className="text-text-muted/70">expires {formatShortDate(invite.expiresAt)}</li>
              ) : null}
            </ul>
          </section>

          {/* Profile (bible A6) */}
          <section className="grid grid-cols-2 gap-2">
            <DetailField label="Role" value={`${displayRoleLabel(employee.role)}${apprentice}`} />
            <DetailField label="Surface" value={appAccessLabel(employee.appAccess)} />
            <DetailField label="Email" value={employee.email || "—"} />
            <DetailField label="Mobile" value={employee.phone || "none"} muted={!employee.phone} />
            <DetailField label="Jobs assigned" value={String(row.jobsCount)} muted={row.jobsCount === 0} />
            <DetailField label="Gear assigned" value={row.gearCount > 0 ? String(row.gearCount) : "none"} muted={row.gearCount === 0} />
          </section>

          {employee.notes ? (
            <DetailField label="Notes (admin only)" value={employee.notes} />
          ) : null}

          <InviteStatusCard
            row={row}
            emailConfigured={emailConfigured}
            busy={busy}
            freshLink={freshLink}
            onResend={doResend}
            onRevoke={() => setConfirm("revoke")}
          />

          {/* Danger zone (bible A6) */}
          {employee.status !== "disabled" ? (
            <section className="rounded-card border border-rose-200 bg-rose-50/50 p-3">
              <h3 className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-rose-700">Danger zone</h3>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-text-muted">Disabling turns off app access. Reversible.</p>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("disable")}>
                  Disable
                </Button>
              </div>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                Permanent delete · lands in O5
              </p>
            </section>
          ) : (
            <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-sm text-text-muted">
              This employee is disabled{employee.disabledAt ? ` (since ${formatShortDate(employee.disabledAt)})` : ""}.
            </p>
          )}
        </div>
      </Drawer>

      <Modal
        open={confirm === "revoke"}
        onClose={() => setConfirm(null)}
        title={`Revoke invite for ${employee.firstName}?`}
      >
        <p className="text-sm text-text-muted">
          They&rsquo;ll see an &ldquo;invite no longer active&rdquo; screen if they open the old link.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={doRevoke}>Revoke invite</Button>
        </div>
      </Modal>

      <Modal
        open={confirm === "disable"}
        onClose={() => setConfirm(null)}
        title={`Disable ${employee.firstName}?`}
      >
        <p className="text-sm text-text-muted">
          They lose app access. You can re-enable them later. (Active sessions are cleared once the
          Phil heartbeat lands — O3.)
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={doDisable}>Disable</Button>
        </div>
      </Modal>
    </>
  );
}

function TimelineRow({ at, label, muted }: { at?: string | null; label: string; muted?: boolean }) {
  return (
    <li className={cn(muted && "text-text-muted/70")}>
      <span className="text-text">{at ? formatDateTime(at) : "— · —"}</span> · {label}
    </li>
  );
}

function DetailField({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={cn("mt-0.5 break-words text-sm", muted ? "text-text-muted" : "text-text")}>{value}</div>
    </div>
  );
}

function appAccessLabel(access: string): string {
  if (access === "phil") return "Phil (field)";
  if (access === "buhlos") return "BuhlOS (office)";
  return "Both";
}

function toAbsolute(relative: string): string {
  if (typeof window === "undefined") return relative;
  if (/^https?:\/\//.test(relative)) return relative;
  return `${window.location.origin}${relative}`;
}
