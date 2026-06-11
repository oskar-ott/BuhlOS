"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";
import { employeeStatusMarker } from "@/domains/employees/service";
import { inviteSummaryLine } from "@/domains/employees/format";
import type { EmployeeRow } from "@/domains/employees/types";

interface InviteStatusCardProps {
  row: EmployeeRow;
  emailConfigured: boolean;
  busy: boolean;
  /** Fresh plaintext link, present only right after issue/resend. */
  freshLink: string | null;
  onResend: () => void;
  onRevoke: () => void;
}

/**
 * Invite lifecycle card (bible A8) — status, a one-line summary, and the two
 * operational actions: resend (which rotates the token and surfaces a fresh
 * copy-link) and revoke. Old tokens can never be retrieved, so the only way to
 * get a working link is to (re)issue one — that's the secure behaviour.
 */
export function InviteStatusCard({
  row,
  emailConfigured,
  busy,
  freshLink,
  onResend,
  onRevoke,
}: InviteStatusCardProps) {
  const { employee, invite } = row;
  const marker = employeeStatusMarker(employee, invite ?? null);
  const [copied, setCopied] = useState(false);
  const isActive = marker.key === "active";
  const isDisabled = marker.key === "disabled";
  const canRevoke =
    Boolean(invite) && invite!.status !== "revoked" && invite!.status !== "accepted";

  async function copy() {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="rounded-card border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">Invite</span>
        <StatusChip tone={marker.tone}>{marker.label}</StatusChip>
      </div>

      <p className="text-sm text-text-muted">
        {invite ? inviteSummaryLine(invite) : "No invite issued yet."}
      </p>

      {freshLink ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            readOnly
            value={freshLink}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-card border border-border bg-surface px-2 py-1.5 font-mono text-xs text-text outline-none"
          />
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}

      {!isActive && !isDisabled ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={onResend}>
            {invite ? (emailConfigured ? "Resend invite" : "Resend / copy link") : "Create invite link"}
          </Button>
          {canRevoke ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={onRevoke}>
              Revoke
            </Button>
          ) : null}
        </div>
      ) : null}

      {isActive ? (
        <p className={cn("mt-3 font-mono text-[11px] uppercase tracking-wider text-text-muted")}>
          Reset PIN · coming soon
        </p>
      ) : null}
    </section>
  );
}
