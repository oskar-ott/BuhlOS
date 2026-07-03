"use client";

import { useMemo, useState } from "react";
import { Check, Link2, Plus, ScanSearch, X } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { EntityLink, SheetRef } from "@/domains/ai-drawings/schema";
import { addLink, proposeLinks, reviewLink } from "@/domains/ai-drawings/client";

/**
 * Epic 5 (#212) — the drawing set as a web, not a pile.
 *
 * Two honest lists: detected reference callouts ("refer E-501") resolved
 * LIVE against the sheet registry (unresolved stays visibly unresolved),
 * and cross-sheet entity links. Link proposals come from exact identifier
 * matches (no AI) and NEVER take effect until a human confirms — rejecting
 * is one tap, and rejected pairs stay rejected. Confirmed links read in
 * both directions and drive the duplicate-count warnings in the counts
 * card.
 */

interface LinksLookup {
  labelFor: (planId: string) => string;
  pageOptions: Array<{ planId: string; pageIndex: number; label: string }>;
}

export function CrossSheetLinksCard({
  jobId,
  refs,
  links,
  lookup,
  onLinks,
  onNotice,
}: {
  jobId: string;
  refs: SheetRef[];
  links: EntityLink[];
  lookup: LinksLookup;
  onLinks: (links: EntityLink[]) => void;
  onNotice?: (notice: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [addIdentifier, setAddIdentifier] = useState("");
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");

  const say = (text: string) => {
    setNotice(text);
    onNotice?.(text);
  };

  const proposed = links.filter((l) => l.status === "proposed");
  const confirmed = links.filter((l) => l.status === "confirmed");
  const rejected = links.filter((l) => l.status === "rejected");

  const refPages = useMemo(() => {
    const byPage = new Map<string, SheetRef[]>();
    for (const r of refs) {
      const key = `${r.planId}:${r.pageIndex}`;
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key)!.push(r);
    }
    return [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [refs]);

  const runScan = async () => {
    setBusy(true);
    setNotice("");
    try {
      const out = await proposeLinks(jobId);
      onLinks(out.links);
      say(
        out.proposed > 0
          ? `Proposed ${out.proposed} link${out.proposed === 1 ? "" : "s"} from ${out.sightings} board sightings — confirm or reject below.`
          : `No new links — ${out.sightings} board sightings scanned, ${out.alreadyKnown} pair${out.alreadyKnown === 1 ? "" : "s"} already known.`,
      );
    } catch (err) {
      say(err instanceof Error ? err.message : "scan failed");
    } finally {
      setBusy(false);
    }
  };

  const runReview = async (link: EntityLink, status: "confirmed" | "rejected") => {
    setBusy(true);
    setNotice("");
    try {
      const out = await reviewLink(jobId, link.id, status);
      onLinks(links.map((l) => (l.id === out.link.id ? out.link : l)));
    } catch (err) {
      say(err instanceof Error ? err.message : "review failed");
    } finally {
      setBusy(false);
    }
  };

  const runAdd = async () => {
    const a = lookup.pageOptions.find((o) => `${o.planId}:${o.pageIndex}` === addA);
    const b = lookup.pageOptions.find((o) => `${o.planId}:${o.pageIndex}` === addB);
    if (!a || !b || !addIdentifier.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const out = await addLink(
        jobId,
        addIdentifier.trim(),
        { planId: a.planId, pageIndex: a.pageIndex },
        { planId: b.planId, pageIndex: b.pageIndex },
      );
      onLinks([...links, out.link]);
      setAddIdentifier("");
      setAddA("");
      setAddB("");
    } catch (err) {
      say(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  };

  const pageLabel = (p: { planId: string; pageIndex: number }) =>
    `${lookup.labelFor(p.planId)} p${p.pageIndex + 1}`;

  return (
    <section
      aria-label="Cross-sheet references and links"
      className="rounded-card border border-border bg-surface"
      data-testid="cross-sheet-links"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle>References &amp; links</CardTitle>
            <CardDescription className="mt-1">
              Callouts resolve live against the sheet register; identity links
              only take effect after <strong>you</strong> confirm them — never
              auto-merged.
            </CardDescription>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runScan()}
            data-testid="scan-links"
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-card border px-3 text-sm font-medium",
              busy
                ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                : "border-brand-navy bg-brand-navy text-text-inverse hover:opacity-90",
            )}
          >
            <ScanSearch aria-hidden="true" className="h-4 w-4" />
            Scan for board links
          </button>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        {proposed.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Proposed — needs your call
            </p>
            <ul className="mt-1 space-y-1">
              {proposed.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap items-center gap-2 rounded-card border border-dashed border-border px-3 py-1.5 text-xs"
                  data-testid="link-proposed"
                >
                  <Link2 aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
                  <span className="font-medium text-text">{l.identifier}</span>
                  <span className="text-text-muted">
                    {pageLabel(l.a)} ↔ {pageLabel(l.b)}
                  </span>
                  {l.confidence !== null ? (
                    <Pill tone="neutral">{Math.round(l.confidence * 100)}%</Pill>
                  ) : null}
                  {l.evidence ? <span className="text-text-muted">{l.evidence}</span> : null}
                  <span className="ml-auto inline-flex gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runReview(l, "confirmed")}
                      data-testid="confirm-link"
                      className="inline-flex h-6 items-center gap-1 rounded-card border border-brand-navy bg-brand-navy px-2 font-medium text-text-inverse hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Check aria-hidden="true" className="h-3 w-3" />
                      Same board
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runReview(l, "rejected")}
                      className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
                    >
                      <X aria-hidden="true" className="h-3 w-3" />
                      Not the same
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {confirmed.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Confirmed
            </p>
            <ul className="mt-1 space-y-1">
              {confirmed.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap items-center gap-2 rounded-card border border-border px-3 py-1.5 text-xs"
                  data-testid="link-confirmed"
                >
                  <Link2 aria-hidden="true" className="h-3.5 w-3.5 text-emerald-700" />
                  <span className="font-medium text-text">{l.identifier}</span>
                  {/* both directions, per the round-trip AC */}
                  <span className="text-text-muted">
                    {pageLabel(l.a)} ↔ {pageLabel(l.b)}
                  </span>
                  <Pill tone="success">
                    <Check aria-hidden="true" className="mr-1 inline h-3 w-3" />
                    {l.reviewedBy ?? l.origin}
                  </Pill>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runReview(l, "rejected")}
                    aria-label={`Unlink ${l.identifier}`}
                    className="ml-auto inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                    Unlink
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {proposed.length === 0 && confirmed.length === 0 ? (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle p-3 text-center text-xs text-text-muted">
            No links yet — scan for board links (schedules + pinned boards
            matched by exact identifier) or add one by hand.
          </p>
        ) : null}
        {rejected.length > 0 ? (
          <p className="text-xs text-text-muted">
            {rejected.length} rejected pair{rejected.length === 1 ? "" : "s"} stay rejected —
            scans never re-propose them.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-text-muted">Link by hand:</span>
          <input
            type="text"
            value={addIdentifier}
            onChange={(e) => setAddIdentifier(e.target.value)}
            placeholder="DB-1"
            aria-label="Identifier for the manual link"
            className="h-6 w-20 rounded-card border border-border bg-surface px-2 text-text"
          />
          <select
            value={addA}
            onChange={(e) => setAddA(e.target.value)}
            aria-label="First sheet for the manual link"
            className="h-6 rounded-card border border-border bg-surface px-1 text-text"
          >
            <option value="">sheet…</option>
            {lookup.pageOptions.map((o) => (
              <option key={`${o.planId}:${o.pageIndex}`} value={`${o.planId}:${o.pageIndex}`}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="text-text-muted">↔</span>
          <select
            value={addB}
            onChange={(e) => setAddB(e.target.value)}
            aria-label="Second sheet for the manual link"
            className="h-6 rounded-card border border-border bg-surface px-1 text-text"
          >
            <option value="">sheet…</option>
            {lookup.pageOptions.map((o) => (
              <option key={`${o.planId}:${o.pageIndex}`} value={`${o.planId}:${o.pageIndex}`}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !addIdentifier.trim() || !addA || !addB || addA === addB}
            onClick={() => void runAdd()}
            className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
          >
            <Plus aria-hidden="true" className="h-3 w-3" />
            Link
          </button>
        </div>

        {refPages.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Reference callouts
            </p>
            <ul className="mt-1 space-y-1">
              {refPages.map(([key, pageRefs]) => {
                const first = pageRefs[0]!;
                return (
                  <li key={key} className="rounded-card border border-border px-3 py-1.5 text-xs">
                    <span className="font-medium text-text">
                      {lookup.labelFor(first.planId)} p{first.pageIndex + 1}
                    </span>
                    <ul className="mt-0.5 space-y-0.5">
                      {pageRefs.map((r) => (
                        <li key={r.id} className="text-text-muted" data-testid="sheet-ref">
                          &ldquo;{r.text}&rdquo; →{" "}
                          {r.resolved ? (
                            <span className="text-text">
                              {lookup.labelFor(r.resolved.planId)} p{r.resolved.pageIndex + 1}
                            </span>
                          ) : (
                            <span className="text-amber-700" data-testid="ref-unresolved">
                              unresolved — no analysed sheet numbered {r.targetSheetNumber}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-text-muted">
            No reference callouts detected yet — run &ldquo;Find references&rdquo; on a
            document&rsquo;s pages.
          </p>
        )}

        {notice ? (
          <p className="text-xs text-amber-700" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </section>
  );
}
