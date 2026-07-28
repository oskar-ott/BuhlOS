"use client";

import { useState } from "react";
import type { Route } from "next";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  MapPin,
  Phone,
} from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilStatusBadge, type PhilStatusTone } from "./ui/PhilStatusBadge";
import { useOnline } from "./useOnline";
import { cn } from "@/lib/cn";
import type { PhilNeedsYouItem } from "@/domains/phil/needs-you";
import { STANDARD_DAY_HOURS } from "@/domains/timesheets/service";
import { formatHoursLabel } from "@/domains/timesheets/format";

/**
 * Phil My Day — sharpened re-skin (phil_sharpened, dark; Wave 2a of the
 * field-surface redesign).
 *
 * Rendered ONLY when the server-resolved `phil_sharpened` flag is on
 * (src/app/phil/my-day/page.tsx branches; flag off = today's screen,
 * byte-identical). Every value here is real or honestly absent (P7):
 *
 *   - The Synced/Offline pill reads navigator.onLine via useOnline. There is
 *     no write outbox in Phil today, so "online" truthfully means nothing is
 *     queued — when an outbox ships, this pill must also check it.
 *   - "Do this now" is the single most urgent item from the EXISTING
 *     needs-you model (buildPhilNeedsYou: rejected hours, calibration
 *     lapses). It is a needs-you surface, NOT a recommender —
 *     P4/P3: the worker's instruction outranks computed ordering; we only
 *     surface what genuinely needs their hand. "Not yet" dismisses the hero
 *     (client state only) and the item drops into the list below — nothing
 *     is lost, nothing is written.
 *   - Check/ITP-owed and unread-safety-doc hero sources do NOT exist as
 *     worker-attributable signals in the needs-you model yet (see
 *     docs/phil-my-day-needs-you.md) — so they are absent, not faked.
 *   - The Quick grid has NO Capture tile: the Capture FAB is the always-
 *     visible centre tab-bar slot directly below this grid, and its
 *     camera-in-the-same-gesture path lives inside PhilTabBar (off-limits to
 *     this wave). A lookalike tile with a different behaviour would be fake
 *     UI (P7); a duplicate two thumb-heights above the real one buys nothing
 *     (P10).
 */

/* ── Section micro-label (design §1: 12px caps, letter-spaced) ─────────── */

function SectionLabel({ children, id }: { children: string; id?: string }) {
  return (
    <h2
      id={id}
      className="mb-2 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted"
    >
      {children}
    </h2>
  );
}

/* ── Header: greeting + real date/on-site subline + truthful sync pill ── */

export function PhilMyDaySharpenedHeader({
  heading,
  subline,
}: {
  /** "Arvo, Sam" — from buildPhilGreeting (real name or impersonal). */
  heading: string;
  /** Real date, plus "· on site since {t}" only when today's entry has a
   *  real start time (the page derives it; never fabricated). */
  subline: string;
}) {
  // Online + no outbox (none exists) → Synced; offline → the canonical
  // Offline badge. SSR/first paint renders online (useOnline contract).
  const online = useOnline();
  return (
    <header
      data-testid="phil-my-day-sharpened-header"
      className="-mx-4 -mt-4 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 pb-4 pt-3"
    >
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-extrabold leading-tight tracking-[-0.02em] text-brand-navy">
          {heading}
        </h1>
        <p className="mt-1 truncate text-[13px] font-medium text-text-muted">{subline}</p>
      </div>
      {online ? (
        <PhilStatusBadge label="Synced" tone="success" className="shrink-0" />
      ) : (
        <PhilStatusBadge label="Offline" className="shrink-0" />
      )}
    </header>
  );
}

/* ── "Log hours now" banner — the design's primary hours affordance ────── */

/**
 * The full-width yellow "Log hours now" banner directly under the header
 * (design §7.5's top action bar). It is a LINK to the Hours tab — the one
 * logging home (W2c) — never a submit button; tapping it logs nothing.
 * Rendered only while today genuinely has no time entry (the page's real
 * todayEntry === null), so its "Today not logged" line is always true (P7).
 * The standard-day figure is the real STANDARD_DAY_HOURS the one-tap
 * Standard-day submit uses — "7h 36m standard", never a hand-written copy.
 */
export function PhilMyDayLogHoursBanner() {
  return (
    <PhilOfflineLink
      href={"/phil/hours" as Route}
      data-testid="phil-my-day-log-hours-banner"
      className="flex min-h-[72px] items-center gap-3 rounded-card bg-accent-yellow p-4 shadow-card active:scale-[0.99]"
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-brand-navy text-accent-yellow"
      >
        <Clock className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-[17px] font-bold leading-tight tracking-[-0.014em] text-accent-ink">
          Log hours now
        </span>
        <span className="mt-0.5 block truncate text-[13px] font-medium text-accent-ink/75">
          {`Today not logged · ${formatHoursLabel(STANDARD_DAY_HOURS)} standard`}
        </span>
      </span>
      <ArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-ink" />
    </PhilOfflineLink>
  );
}

/* ── "Do this now" hero + "Needs you · n" list ─────────────────────────── */

/** Hero verb per item kind. Rejected hours get the design's "Fix & resend";
 *  everything else keeps the needs-you model's own action label. */
function heroActionLabel(item: PhilNeedsYouItem): string {
  return item.kind === "rejected-hours" ? "Fix & resend" : item.actionLabel;
}

/**
 * One badge per needs-you kind, honest to what the item IS:
 *   rejected-hours → the canonical Rejected;
 *   calibration    → Expired / Due soon (domain words, danger/warning tone).
 */
export function philNeedsYouBadge(item: PhilNeedsYouItem): {
  label: string;
  tone: PhilStatusTone;
} {
  switch (item.kind) {
    case "rejected-hours":
      return { label: "Rejected", tone: "danger" };
    case "calibration":
      return item.severity === "urgent"
        ? { label: "Expired", tone: "danger" }
        : { label: "Due soon", tone: "warning" };
  }
}

export function PhilMyDayDoThisNow({
  items,
}: {
  /** The FULL needs-you list (buildPhilNeedsYou output, already sorted most
   *  urgent first). items[0] is the hero; the rest are the list. */
  items: ReadonlyArray<PhilNeedsYouItem>;
}) {
  // "Not yet" — client state only. The hero drops into the list below so the
  // item stays visible and actionable; nothing is dismissed server-side.
  const [heroDismissed, setHeroDismissed] = useState(false);

  if (items.length === 0) {
    // Honest all-clear — site voice, no fake urgency, no invented card.
    return (
      <p
        data-testid="phil-my-day-all-clear"
        className="rounded-card border border-border bg-surface-raised px-4 py-4 text-center font-display text-[15px] font-bold text-text"
      >
        Nothing&rsquo;s chasing you.
      </p>
    );
  }

  const hero = heroDismissed ? null : items[0]!;
  const rest = heroDismissed ? items : items.slice(1);

  return (
    <div className="space-y-3">
      {hero ? (
        <section
          aria-label="Do this now"
          data-testid="phil-my-day-do-this-now"
          className="rounded-card border border-border border-l-[5px] border-l-accent-yellow bg-surface-raised p-4 shadow-card"
        >
          <p className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            Do this now
          </p>
          <p className="mt-1.5 font-display text-[17px] font-bold leading-snug tracking-[-0.014em] text-text">
            {hero.title}
          </p>
          {hero.detail ? (
            <p className="mt-1 text-[13px] leading-snug text-text-muted">{hero.detail}</p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <PhilOfflineLink
              href={hero.href as Route}
              data-testid="phil-my-day-do-this-now-action"
              className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-card bg-brand-navy px-4 font-display text-sm font-bold text-text-inverse active:scale-[0.99]"
            >
              {heroActionLabel(hero)}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </PhilOfflineLink>
            <button
              type="button"
              onClick={() => setHeroDismissed(true)}
              data-testid="phil-my-day-do-this-now-not-yet"
              className="inline-flex min-h-[48px] items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-semibold text-text hover:bg-surface-subtle active:scale-[0.99]"
            >
              Not yet
            </button>
          </div>
        </section>
      ) : null}

      {rest.length > 0 ? (
        <section aria-label="Needs you">
          <SectionLabel>{`Needs you · ${rest.length}`}</SectionLabel>
          <ul
            data-testid="phil-my-day-needs-you"
            className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised"
          >
            {rest.map((it) => {
              const badge = philNeedsYouBadge(it);
              return (
                <li key={it.id}>
                  <PhilOfflineLink
                    href={it.href as Route}
                    className="flex min-h-[56px] items-center gap-3 px-4 py-3 hover:bg-surface-subtle"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold leading-snug text-text">
                        {it.title}
                      </span>
                      {it.detail ? (
                        <span className="mt-0.5 block truncate text-[12px] text-text-muted">
                          {it.detail}
                        </span>
                      ) : null}
                    </span>
                    <PhilStatusBadge label={badge.label} tone={badge.tone} className="shrink-0" />
                  </PhilOfflineLink>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ── "On the job" — the worker's one real job context ──────────────────── */

export function PhilMyDayOnJobCard({
  job,
}: {
  /** The sole assigned job (the page's existing exactly-one signal — there
   *  is no "active job" field, so with 0 or 2+ jobs this card is omitted,
   *  never guessed). ref/siteAddress render only when present. */
  job: { id: string; name: string; ref?: string | null; siteAddress?: string | null };
}) {
  return (
    <section aria-labelledby="phil-my-day-on-job">
      <SectionLabel id="phil-my-day-on-job">On the job</SectionLabel>
      <PhilOfflineLink
        href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
        data-testid="phil-my-day-on-job-card"
        className="flex min-h-[64px] items-center gap-3 rounded-card border border-border bg-surface-raised p-4 shadow-card hover:bg-surface-subtle"
      >
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-navy text-accent-yellow"
        >
          <MapPin className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          {job.ref ? (
            <span className="block font-display text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted [font-variant-numeric:tabular-nums]">
              {job.ref}
            </span>
          ) : null}
          <span className="block truncate font-display text-base font-bold text-text">
            {job.name}
          </span>
          {job.siteAddress ? (
            <span className="block truncate text-[13px] text-text-muted">{job.siteAddress}</span>
          ) : null}
        </span>
        <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
      </PhilOfflineLink>
    </section>
  );
}

/* ── Quick grid ────────────────────────────────────────────────────────── */

export function PhilMyDayQuickGrid({
  hoursDue,
  callJobId,
}: {
  /** True only when today genuinely has no time entry (the page's real
   *  todayEntry === null) — drives the amber "Due" chip. */
  hoursDue: boolean;
  /** The sole job's id, or null. "Who to call" needs a job context (the
   *  contacts live on the job) — with none the tile is omitted, not faked. */
  callJobId: string | null;
}) {
  const tileClass =
    "flex min-h-[84px] flex-col gap-1.5 rounded-card border border-border bg-surface-raised p-3 text-left shadow-card transition-colors active:bg-surface-subtle";

  return (
    <section aria-labelledby="phil-my-day-quick">
      <SectionLabel id="phil-my-day-quick">Quick</SectionLabel>
      <div className="grid grid-cols-2 gap-2" data-testid="phil-my-day-quick-grid">
        {/* Log hours now → the Hours tab (§7.5). The chip is real: it renders
            only when today's entry is genuinely missing. */}
        <PhilOfflineLink href={"/phil/hours" as Route} className={tileClass}>
          <span className="flex w-full items-start justify-between">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent-yellow text-accent-ink">
              <Clock className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            {hoursDue ? <PhilStatusBadge label="Due" tone="warning" /> : null}
          </span>
          <span className="text-sm font-semibold leading-tight text-text">Log hours now</span>
          <span className="text-xs leading-tight text-text-muted">
            {hoursDue ? "Today's not logged yet" : "Today's hours"}
          </span>
        </PhilOfflineLink>

        {/* Who to call — the current job's real contacts section. Omitted
            without a job context (no invented directory). */}
        {callJobId ? (
          <PhilOfflineLink
            href={`/phil/jobs/${encodeURIComponent(callJobId)}#phil-job-contacts` as Route}
            data-testid="phil-my-day-who-to-call"
            className={tileClass}
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-state-info-subtle-bg text-state-info-subtle-text">
              <Phone className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold leading-tight text-text">Who to call</span>
            <span className="text-xs leading-tight text-text-muted">This job&rsquo;s contacts</span>
          </PhilOfflineLink>
        ) : null}
      </div>
    </section>
  );
}

/* ── Honesty note (truth over theatre) ─────────────────────────────────── */

export function PhilMyDayHonestyNote({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-card border border-dashed border-border bg-surface-subtle px-4 py-3",
        className,
      )}
    >
      <p className="text-sm text-text-muted">
        Materials &amp; job history aren&rsquo;t connected yet — so Phil doesn&rsquo;t show
        them.
      </p>
    </div>
  );
}
