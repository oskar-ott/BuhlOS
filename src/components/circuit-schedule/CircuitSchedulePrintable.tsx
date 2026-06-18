"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import {
  boardTitle,
  circuitTypeLabel,
  deviceLabel,
  groupCircuitsByBoard,
  statusLabel,
} from "@/domains/circuit-schedule/format";
import type { Circuit, Switchboard } from "@/domains/circuit-schedule/types";

/**
 * Printable circuit schedule — the office-issued, compliance-pack artefact.
 *
 * Rendered on a bare page (no app shell) so a browser "Print / Save as PDF"
 * produces a clean per-board schedule. The toolbar is `print:hidden`; the
 * tables carry visible borders only in print so on-screen it stays light.
 *
 * Data is whatever was saved through the builder — no invented rows, no
 * placeholder ratings (P7 truth over theatre). A board with no circuits prints
 * its header and an honest "no circuits recorded" line.
 */

interface Props {
  job: { id: string; name: string; ref?: string; siteAddress?: string };
  switchboards: ReadonlyArray<Switchboard>;
  circuits: ReadonlyArray<Circuit>;
  backHref: string;
}

const COLS = [
  "Circuit",
  "Description",
  "Type",
  "Device",
  "Rating",
  "Cable",
  "Status",
] as const;

export function CircuitSchedulePrintable({ job, switchboards, circuits, backHref }: Props) {
  const groups = groupCircuitsByBoard(switchboards, circuits);
  const printedOn = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 text-text print:px-0 print:py-0">
      <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-text-muted underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to schedule
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-card bg-brand-navy px-4 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink"
        >
          <Printer aria-hidden="true" className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>

      <header className="mb-6 border-b border-border pb-4">
        <h1 className="font-display text-2xl font-semibold">Circuit schedule</h1>
        <p className="mt-1 text-base">{job.name}</p>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-muted">
          {job.ref ? <span>Ref {job.ref}</span> : null}
          {job.siteAddress ? <span>{job.siteAddress}</span> : null}
          <span>Printed {printedOn}</span>
        </dl>
      </header>

      {groups.length === 0 ? (
        <p className="text-sm text-text-muted">
          No distribution boards have been recorded for this job yet.
        </p>
      ) : (
        <div className="space-y-8">
          {groups.map(({ board, circuits: rows }) => (
            <section key={board.id} className="break-inside-avoid">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg font-semibold">{boardTitle(board)}</h2>
                {board.location?.trim() ? (
                  <span className="text-sm text-text-muted">{board.location.trim()}</span>
                ) : null}
              </div>
              {rows.length === 0 ? (
                <p className="text-sm text-text-muted">No circuits recorded on this board.</p>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-y border-border text-left">
                      {COLS.map((col) => (
                        <th
                          key={col}
                          className="px-2 py-1.5 font-display text-[11px] uppercase tracking-wider text-text-muted"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className="border-b border-border align-top">
                        <td className="px-2 py-1.5 font-medium">{c.number?.trim() || "—"}</td>
                        <td className="px-2 py-1.5">{c.description?.trim() || "—"}</td>
                        <td className="px-2 py-1.5">{circuitTypeLabel(c.type) || "—"}</td>
                        <td className="px-2 py-1.5">{deviceLabel(c.device) || "—"}</td>
                        <td className="px-2 py-1.5">{c.rating?.trim() || "—"}</td>
                        <td className="px-2 py-1.5">{c.cableSize?.trim() || "—"}</td>
                        <td className="px-2 py-1.5">{statusLabel(c.status) || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
