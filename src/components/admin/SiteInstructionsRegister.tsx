"use client";

import { useState, type FormEvent } from "react";
import {
  acknowledgeInstruction,
  closeInstruction,
  fetchInstructions,
  patchInstruction,
  recordInstruction,
} from "@/domains/site-instructions/client";
import {
  INSTRUCTION_CHANNELS,
  type InstructionChannel,
  type SiteInstruction,
} from "@/domains/site-instructions/schema";
import { isAwaitingSpawn, sortInstructionsForRegister } from "@/domains/site-instructions/logic";

/**
 * The per-job site-instructions register (#283): record a builder's directed
 * work (who/what/when/channel), acknowledge it formally, and flag the ones with
 * a cost/time implication so they spawn an RFI/variation instead of becoming
 * free work. Admin writes; managing-LH reads (no dead controls). The flagged-
 * but-unlinked rows sort to the top — that is free work in progress.
 */

const CHANNEL_LABELS: Record<InstructionChannel, string> = {
  verbal: "Verbal",
  phone: "Phone",
  email: "Email",
  text: "Text",
  on_site: "On site",
};

const STATUS_LABELS: Record<SiteInstruction["status"], string> = {
  recorded: "Recorded",
  acknowledged: "Acknowledged",
  closed: "Closed",
};

export function SiteInstructionsRegister({
  jobId,
  initialInstructions,
  fetchError,
  canWrite,
}: {
  jobId: string;
  initialInstructions: SiteInstruction[];
  fetchError: string | null;
  /** Admin-tier only: api/site-instructions.js 403s an LH's writes, so an LH
   *  reads the register but never sees a control that can't submit. */
  canWrite: boolean;
}) {
  const [instructions, setInstructions] = useState<SiteInstruction[]>(initialInstructions);
  const [error, setError] = useState<string | null>(fetchError);
  const [busy, setBusy] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<InstructionChannel>("phone");
  const [dateReceived, setDateReceived] = useState(today);
  const [text, setText] = useState("");
  const [implication, setImplication] = useState(false);

  async function refresh() {
    try {
      const res = await fetchInstructions(jobId);
      setInstructions(res.instructions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reload");
    }
  }

  async function onRecord(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await recordInstruction(jobId, {
        instructedBy: { name: name.trim(), email: email.trim() || null },
        channel,
        instructionText: text.trim(),
        dateReceived,
        costTimeImplication: implication,
      });
      setName("");
      setEmail("");
      setText("");
      setImplication(false);
      setChannel("phone");
      setDateReceived(today);
      await refresh();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Couldn't record the instruction");
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }

  const sorted = sortInstructionsForRegister(instructions);

  return (
    <div className="space-y-6" data-testid="site-instructions-register">
      <header>
        <h1 className="font-display text-xl font-semibold text-text">Site instructions</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every builder instruction recorded and formally acknowledged, so scope directed on site is
          provable — and the costed ones become variations instead of free work.
        </p>
      </header>

      {error ? (
        <div role="alert" className="rounded-md border border-status-danger/40 bg-status-danger/10 px-3 py-2 text-sm text-text">
          {error}
        </div>
      ) : null}

      {canWrite ? (
        <form onSubmit={onRecord} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-text">Record an instruction</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-text-muted">Instructed by</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Bob — site super"
                className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-text"
                aria-label="Instructed by"
              />
            </label>
            <label className="block text-sm">
              <span className="text-text-muted">Their email (optional)</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="for a later acknowledgement"
                className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-text"
                aria-label="Instructed-by email"
              />
            </label>
            <label className="block text-sm">
              <span className="text-text-muted">Channel</span>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as InstructionChannel)}
                className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-text"
                aria-label="Channel"
              >
                {INSTRUCTION_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-text-muted">Date received</span>
              <input
                type="date"
                value={dateReceived}
                onChange={(e) => setDateReceived(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-text"
                aria-label="Date received"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-text-muted">Instruction (verbatim)</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="e.g. Move the GPO in unit 4 kitchen to the east wall."
              className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-text"
              aria-label="Instruction text"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={implication} onChange={(e) => setImplication(e.target.checked)} />
            This instruction has a cost or time implication
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim() || !text.trim()}
            className="rounded-md bg-accent-yellow px-3 py-1.5 text-sm font-semibold text-bg disabled:opacity-50"
          >
            {busy ? "Recording…" : "Record instruction"}
          </button>
        </form>
      ) : null}

      {sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
          No site instructions recorded yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((si) => (
            <InstructionRow key={si.id} jobId={jobId} si={si} canWrite={canWrite} busy={busy} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InstructionRow({
  jobId,
  si,
  canWrite,
  busy,
  run,
}: {
  jobId: string;
  si: SiteInstruction;
  canWrite: boolean;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [ackChannel, setAckChannel] = useState<InstructionChannel>("phone");
  const [closeReason, setCloseReason] = useState("");
  const [linkRfi, setLinkRfi] = useState("");
  const awaiting = isAwaitingSpawn(si);

  return (
    <li
      className={`rounded-lg border bg-surface p-4 ${awaiting ? "border-status-warning/60" : "border-border"}`}
      data-testid="instruction-row"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-semibold text-text">{si.ref}</span>
        <span className="rounded-full bg-bg px-2 py-0.5 text-xs text-text-muted">{STATUS_LABELS[si.status]}</span>
        <span className="text-text-muted">· {CHANNEL_LABELS[si.channel]} · {si.dateReceived}</span>
        {awaiting ? (
          <span className="rounded-full bg-status-warning/15 px-2 py-0.5 text-xs font-semibold text-status-warning">
            Cost/time flagged — nothing spawned
          </span>
        ) : null}
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm text-text">{si.instructionText}</p>
      <p className="mt-1 text-xs text-text-muted">
        From {si.instructedBy.name}
        {si.instructedBy.email ? ` · ${si.instructedBy.email}` : ""} · recorded by {si.recordedBy}
      </p>

      {si.linkedRfiId ? <p className="mt-1 text-xs text-text-muted">Linked RFI: {si.linkedRfiId}</p> : null}
      {si.linkedVariationId ? <p className="mt-1 text-xs text-text-muted">Linked variation: {si.linkedVariationId}</p> : null}
      {si.status === "acknowledged" && si.acknowledgedAt ? (
        <p className="mt-1 text-xs text-text-muted">
          Acknowledged by {si.acknowledgedBy}
          {si.acknowledgementChannel ? ` (${CHANNEL_LABELS[si.acknowledgementChannel]})` : ""}
          {si.emailSentAt ? " · email sent" : ""}
        </p>
      ) : null}
      {si.status === "closed" ? (
        <p className="mt-1 text-xs text-text-muted">
          Closed by {si.closedBy}
          {si.closeReason ? ` — ${si.closeReason}` : ""}
        </p>
      ) : null}

      {canWrite && si.status !== "closed" ? (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3 text-sm">
          {si.status === "recorded" ? (
            <div className="flex items-end gap-1">
              <label className="text-xs text-text-muted">
                Acknowledge
                <select
                  value={ackChannel}
                  onChange={(e) => setAckChannel(e.target.value as InstructionChannel)}
                  className="ml-1 rounded border border-border bg-bg px-1.5 py-1 text-text"
                  aria-label={`Acknowledge ${si.ref} via`}
                >
                  {INSTRUCTION_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => acknowledgeInstruction(jobId, si.id, ackChannel))}
                className="rounded-md border border-border px-2 py-1 font-medium text-text disabled:opacity-50"
              >
                Confirm back
              </button>
            </div>
          ) : null}

          {!si.linkedRfiId ? (
            <div className="flex items-end gap-1">
              <input
                value={linkRfi}
                onChange={(e) => setLinkRfi(e.target.value)}
                placeholder="RFI id"
                aria-label={`Link an RFI to ${si.ref}`}
                className="w-24 rounded border border-border bg-bg px-1.5 py-1 text-text"
              />
              <button
                type="button"
                disabled={busy || !linkRfi.trim()}
                onClick={() => run(() => patchInstruction(jobId, si.id, { linkedRfiId: linkRfi.trim() }))}
                className="rounded-md border border-border px-2 py-1 font-medium text-text disabled:opacity-50"
              >
                Link RFI
              </button>
            </div>
          ) : null}

          {!si.costTimeImplication ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => patchInstruction(jobId, si.id, { costTimeImplication: true }))}
              className="rounded-md border border-border px-2 py-1 font-medium text-text disabled:opacity-50"
            >
              Flag cost/time
            </button>
          ) : null}

          <div className="flex items-end gap-1">
            <input
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="close reason"
              aria-label={`Close ${si.ref} reason`}
              className="w-32 rounded border border-border bg-bg px-1.5 py-1 text-text"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => closeInstruction(jobId, si.id, closeReason.trim()))}
              className="rounded-md border border-border px-2 py-1 font-medium text-text disabled:opacity-50"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
