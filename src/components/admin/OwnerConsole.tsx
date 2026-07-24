"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { OwnerFeatureBoard } from "@/components/admin/OwnerFeatureBoard";
import { OwnerSettingsControls } from "@/components/admin/OwnerSettingsControls";
import { pctWidthClass } from "@/components/admin/pct-width";
import {
  type HealthCheck,
  type OwnerSummary,
  expiryTone,
  flagSourceLabel,
  flagStateTone,
  healthLabel,
  healthTone,
  severityLabel,
  severityTone,
  sortProblems,
} from "@/domains/platform/owner-console";

/**
 * Owner Console board (docs/owner-console.md) — the owner-gated summary from
 * /api/owner rendered as a switchboard: a navy identity band, jump-tiles for
 * the headline numbers, and a sticky section rail with live status markers.
 * The page resolves access + data server-side and hands a parsed `OwnerSummary`
 * here; this component is a client island so the rail can scroll-spy, but it
 * renders fully on the server (all panels present in the SSR HTML — nothing is
 * hidden behind a tab).
 *
 * Honesty rules (P7): every panel shows its data source + freshness, or an
 * explicit "not instrumented yet" label. Bars are scaled to real counts only.
 * No fake metrics, no invented zeros, no vanity numbers.
 */
export function OwnerConsole({ summary }: { summary: OwnerSummary }) {
  const {
    meta,
    capabilities,
    health,
    flags,
    settings,
    usage,
    errors,
    audit,
    coverage,
    problems,
    nextActions,
  } = summary;

  const onCount = flags.items.filter((f) => f.resolved).length;
  const expiredCount = flags.items.filter((f) => f.expiryStatus === "expired").length;
  const expiringCount = flags.items.filter((f) => f.expiryStatus === "expiring").length;
  const blockerHigh = problems.filter(
    (p) => p.severity === "blocker" || p.severity === "high",
  ).length;
  const gapCount =
    health.notInstrumented.length +
    usage.notInstrumented.length +
    problems.filter((p) => p.severity === "not_instrumented").length;
  const hasSettings = !!settings && settings.items.length > 0;
  const errorCount7d = errors?.available ? errors.count7d : 0;

  const railItems = useMemo<RailItem[]>(() => {
    const items: RailItem[] = [
      { id: "health", label: "Health", dot: healthTone(health.overall) },
      { id: "usage", label: "Usage", count: String(usage.auditEvents7d) },
      {
        id: "errors",
        label: "Errors",
        count: String(errorCount7d),
        dot: errorCount7d > 0 ? "danger" : undefined,
      },
      { id: "features", label: "Features", count: `${onCount}/${flags.items.length}` },
    ];
    if (hasSettings) {
      items.push({ id: "config", label: "Configuration", count: String(settings.items.length) });
    }
    items.push(
      {
        id: "problems",
        label: "Problems",
        count: String(problems.length),
        dot: blockerHigh > 0 ? "danger" : problems.length > 0 ? "warning" : undefined,
      },
      { id: "audit", label: "Audit trail" },
      { id: "coverage", label: "Coverage" },
      { id: "actions", label: "Next actions", count: String(nextActions.length) },
    );
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);

  const sectionIds = useMemo(() => railItems.map((i) => i.id), [railItems]);
  const [active, setActive] = useState<string>(sectionIds[0] ?? "health");
  // After a rail click, hold the clicked section active while the smooth
  // scroll runs — otherwise the spy re-picks a neighbour when the target
  // section can't reach the reference line (e.g. at the bottom of the page).
  const spyPausedUntil = useRef(0);

  // Scroll-spy: the rail highlights the last section whose top has passed a
  // reference line at 25% of the viewport. A capturing document listener sees
  // the admin shell's inner scroll container too (the window itself may never
  // scroll). Effects never run under renderToString, so SSR is unaffected.
  useEffect(() => {
    let frame = 0;
    function recompute() {
      frame = 0;
      const refLine = window.innerHeight * 0.25;
      let best: string | null = null;
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= refLine) best = id;
      }
      setActive(best ?? sectionIds[0] ?? "health");
    }
    function onScroll() {
      if (Date.now() < spyPausedUntil.current) return;
      if (!frame) frame = requestAnimationFrame(recompute);
    }
    recompute();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [sectionIds]);

  function jumpTo(id: string) {
    spyPausedUntil.current = Date.now() + 1000;
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (typeof history !== "undefined") history.replaceState(null, "", `#${id}`);
  }

  return (
    <div className="mx-auto max-w-6xl">
      {/* ── Identity band ─────────────────────────────────────────────── */}
      <section id="overview" className="overflow-hidden rounded-card bg-brand-navy shadow-raised">
        <div className="p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-accent-yellow">
                Owner console
              </p>
              <h2 className="mt-1 font-display text-2xl text-white sm:text-3xl">
                Platform control
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">
                Private control surface for app health, usage, feature flags, and product
                risk. Owner-only
                {capabilities.flagToggle
                  ? " — switch features off for customers and preview unbuilt work live."
                  : " — read-only in this first slice."}
              </p>
            </div>
            {capabilities.flagToggle ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-accent-yellow px-2.5 py-1 font-mono text-[12px] font-semibold uppercase tracking-wider text-brand-navy">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-navy" />
                Owner controls
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center rounded-pill border border-white/25 px-2.5 py-1 font-mono text-[12px] font-semibold uppercase tracking-wider text-white/80">
                Read-only
              </span>
            )}
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-white/10 pt-4 text-sm sm:grid-cols-4">
            <MetaItem
              label="Environment"
              value={meta.environment}
              live={meta.environment === "production"}
            />
            <MetaItem
              label="Access via"
              value={meta.identityBasis === "owner-role" ? "owner role" : "email allowlist"}
            />
            <MetaItem
              label="Signed in"
              value={meta.viewer.name ?? meta.viewer.email ?? meta.viewer.role ?? "—"}
            />
            <MetaItem label="Loaded" value={fmtTime(meta.asOf)} />
          </dl>
        </div>
      </section>

      {/* ── Headline jump-tiles ───────────────────────────────────────── */}
      <section aria-label="Summary" className="mt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <JumpTile
            targetId="health"
            onJump={jumpTo}
            label="Health"
            value={healthLabel(health.overall)}
            hint="live probes"
            dot={healthTone(health.overall)}
          />
          <JumpTile
            targetId="usage"
            onJump={jumpTo}
            label="Activity (7d)"
            value={String(usage.auditEvents7d)}
            hint="audit events"
          />
          <JumpTile
            targetId="features"
            onJump={jumpTo}
            label="Features live"
            value={`${onCount}/${flags.items.length}`}
            hint={expiredCount ? `${expiredCount} expired` : "all in date"}
            dot={expiredCount ? "danger" : undefined}
          />
          <JumpTile
            targetId="problems"
            onJump={jumpTo}
            label="Problems"
            value={String(problems.length)}
            hint={blockerHigh ? `${blockerHigh} high or worse` : "none high"}
            dot={blockerHigh ? "warning" : undefined}
          />
          <JumpTile
            targetId="problems"
            onJump={jumpTo}
            label="Instrumentation gaps"
            value={String(gapCount)}
            hint="not wired yet"
          />
        </div>
      </section>

      {/* ── Mobile section nav (chips) ────────────────────────────────── */}
      <nav
        aria-label="Console sections"
        className="sticky top-0 z-10 -mx-4 mt-4 overflow-x-auto border-b border-border bg-surface-subtle/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden"
      >
        <div className="flex w-max gap-1.5">
          {railItems.map((it) => (
            <a
              key={it.id}
              href={`#${it.id}`}
              onClick={(e) => {
                e.preventDefault();
                jumpTo(it.id);
              }}
              aria-current={active === it.id ? "true" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3 py-1 text-xs font-medium transition-colors",
                active === it.id
                  ? "bg-brand-navy text-white"
                  : "border border-border bg-surface-raised text-text-muted",
              )}
            >
              {it.dot ? <RailDot tone={it.dot} /> : null}
              {it.label}
            </a>
          ))}
        </div>
      </nav>

      {/* ── Rail + panels ─────────────────────────────────────────────── */}
      <div className="mt-6 items-start lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Console sections" className="sticky top-1 hidden self-start lg:block">
          <ul className="space-y-0.5">
            {railItems.map((it) => {
              const isActive = active === it.id;
              return (
                <li key={it.id}>
                  <a
                    href={`#${it.id}`}
                    aria-current={isActive ? "true" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      jumpTo(it.id);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-card px-3 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-brand-navy text-white shadow-card"
                        : "text-text-muted hover:bg-surface-raised hover:text-text",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {it.dot ? <RailDot tone={it.dot} /> : null}
                      <span className="truncate">{it.label}</span>
                    </span>
                    {it.count != null ? (
                      <span
                        className={cn(
                          "font-mono text-[11px] tabular-nums",
                          isActive ? "text-white/70" : "text-text-muted",
                        )}
                      >
                        {it.count}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-10">
          {/* Product health */}
          <Panel
            id="health"
            title="Product health"
            source="Live probes at load — Blob, session key, flag expiry"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {health.checks.map((c) => (
                <div
                  key={c.id}
                  className="flex items-start gap-3 rounded-card border border-border bg-surface-raised p-4"
                >
                  <ProbeLed status={c.status} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-text">{c.label}</p>
                      {c.status !== "ok" ? (
                        <StatusChip
                          tone={c.status === "warning" ? "warning" : "danger"}
                          dot={false}
                        >
                          {c.status}
                        </StatusChip>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-text-muted">{c.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            <NotInstrumented items={health.notInstrumented} />
          </Panel>

          {/* Usage & activity */}
          <Panel id="usage" title="Usage & activity" source={usage.source}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Meter label="Events (7d)" value={String(usage.auditEvents7d)} />
              <Meter label="Active people (7d)" value={String(usage.distinctActors7d)} />
              <Meter
                label="Events this month"
                value={String(usage.monthEntryCount)}
                hint={`cap ${usage.monthCap}`}
              />
              <Meter
                label="Top actions"
                value={String(usage.topActions.length)}
                hint="charted below"
              />
            </div>
            {usage.topActions.length > 0 ? (
              <div className="mt-3 rounded-card border border-border bg-surface-raised p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Top actions · last 7 days
                </p>
                <div className="mt-3 space-y-2">
                  {usage.topActions.map((a) => (
                    <BarRow
                      key={a.action}
                      label={a.action}
                      count={a.count}
                      max={Math.max(...usage.topActions.map((t) => t.count))}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-text-muted">
                No activity recorded in the last 7 days.
              </p>
            )}
            <NotInstrumented items={usage.notInstrumented} />
          </Panel>

          {/* Errors (#154) — the platform error journal. Partial by design; the
              caption states scope so the panel never overclaims coverage. */}
          <Panel
            id="errors"
            title="Errors"
            source={errors?.source ?? "platform error journal (platform/errors.json)"}
            caption={errors?.coverageNote}
          >
            {!errors ? (
              <EmptyState
                title="Errors panel unavailable"
                description="The owner endpoint did not return the errors section."
              />
            ) : !errors.available ? (
              <EmptyState
                title="No errors recorded yet"
                description="Nothing captured by the wrapped api handlers or the client error boundary."
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Meter label="Events (7d)" value={String(errors.count7d)} />
                  <Meter label="Recorded" value={String(errors.total)} hint={`cap ${errors.cap}`} />
                  <Meter
                    label="Top groups"
                    value={String(errors.topGroups.length)}
                    hint="by fingerprint"
                  />
                </div>
                {errors.topGroups.length > 0 ? (
                  <div className="mt-3 rounded-card border border-border bg-surface-raised p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                      Grouped by fingerprint
                    </p>
                    <div className="mt-3 space-y-3">
                      {errors.topGroups.map((g) => (
                        <div key={g.fingerprint}>
                          <BarRow
                            label={g.handler}
                            count={g.count}
                            max={Math.max(...errors.topGroups.map((t) => t.count))}
                            tone="danger"
                          />
                          <p className="mt-0.5 truncate text-xs text-text-muted">
                            {g.message} · last seen {fmtTime(g.lastSeen)} · {g.source}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {errors.recent.length > 0 ? (
                  <details className="group mt-3 overflow-hidden rounded-card border border-border bg-surface-raised">
                    <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-2.5 text-sm font-medium text-text hover:bg-surface-subtle">
                      Recent events ({errors.recent.length})
                      <span
                        aria-hidden="true"
                        className="text-text-muted transition-transform group-open:rotate-180"
                      >
                        ▾
                      </span>
                    </summary>
                    <div className="divide-y divide-border border-t border-border">
                      {errors.recent.map((e) => (
                        <div
                          key={e.id}
                          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                        >
                          <span className="font-mono text-xs text-text-muted">{fmtTime(e.ts)}</span>
                          <span className="font-mono text-sm font-semibold text-text">
                            {e.handler}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                            {e.message}
                          </span>
                          <span className="ml-auto text-xs text-text-muted">
                            {e.source}
                            {e.statusCode != null ? ` · ${e.statusCode}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </>
            )}
          </Panel>

          {/* Feature control board (#760) */}
          <Panel
            id="features"
            title="Feature control"
            source={flags.source}
            caption={
              capabilities.flagToggle
                ? `${onCount} on · ${expiredCount} expired · ${expiringCount} expiring soon · grouped by area; two dials per feature — Live to customers + Preview for me. Data-plane flags stay read-only.`
                : `${onCount} on · ${expiredCount} expired · ${expiringCount} expiring soon · read-only (${capabilities.flagToggleReason})`
            }
          >
            {flags.items.length === 0 ? (
              <EmptyState
                title="No flags resolved"
                description={flags.error ?? "The flag registry returned nothing."}
              />
            ) : capabilities.flagToggle ? (
              <div className="space-y-3">
                {meta.identityBasis === "email-allowlist" ? (
                  <div
                    role="note"
                    className="rounded-card border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
                  >
                    You&rsquo;re signed in via the email allowlist, not the{" "}
                    <span className="font-mono">owner</span> role. Customer toggles work, but{" "}
                    <strong>Preview for me</strong> only takes effect in the live app when your
                    account has the <span className="font-mono">owner</span> role.
                  </div>
                ) : null}
                <OwnerFeatureBoard items={flags.items} rev={flags.rev} />
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
                {flags.items.map((f) => (
                  <div key={f.key} className="space-y-1.5 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-text">{f.key}</span>
                      <StatusChip tone={flagStateTone(f.resolved)}>
                        {f.resolved ? "On" : "Off"}
                      </StatusChip>
                      {f.expiryStatus !== "ok" ? (
                        <StatusChip tone={expiryTone(f.expiryStatus)}>{f.expiryStatus}</StatusChip>
                      ) : null}
                      {f.protected ? (
                        <StatusChip tone="neutral" dot={false}>
                          protected
                        </StatusChip>
                      ) : null}
                    </div>
                    <p className="text-sm text-text-muted">{f.description}</p>
                    <p className="text-xs text-text-muted">
                      source: {flagSourceLabel(f.source)} · target: {f.target} · expires{" "}
                      {f.expires} · default {f.default ? "on" : "off"} ·{" "}
                      {f.toggleable ? "toggleable" : "read-only"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Feature configuration (#760 PR2) */}
          {hasSettings ? (
            <Panel
              id="config"
              title="Feature configuration"
              source={settings.source}
              caption={
                capabilities.settingsWrite
                  ? "Tune feature settings at runtime — each default equals the live value until you change it."
                  : "Read-only."
              }
            >
              {capabilities.settingsWrite ? (
                <OwnerSettingsControls items={settings.items} rev={settings.rev} />
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
                  {settings.items.map((s) => (
                    <div key={`${s.featureKey}.${s.key}`} className="space-y-1 px-4 py-3">
                      <p className="text-sm font-medium text-text">{s.label}</p>
                      <p className="text-xs text-text-muted">
                        <span className="font-mono">
                          {s.featureKey}.{s.key}
                        </span>{" "}
                        · {String(s.value)}
                        {s.unit ? ` ${s.unit}` : ""} · default {String(s.default)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          ) : null}

          {/* Product problems */}
          <Panel
            id="problems"
            title="Product problems"
            source="Derived from real signals — flag expiry, health probes, instrumentation gaps"
          >
            {problems.length === 0 ? (
              <EmptyState
                title="Nothing flagged"
                description="No problems derived from current signals."
              />
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
                {sortProblems(problems).map((p, i) => (
                  <div key={`${p.title}-${i}`} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={severityTone(p.severity)}>
                        {severityLabel(p.severity)}
                      </StatusChip>
                      <span className="font-medium text-text">{p.title}</span>
                    </div>
                    <p className="mt-1.5 text-sm text-text-muted">{p.why}</p>
                    <p className="mt-1 text-xs text-text-muted">
                      Evidence: {p.evidence} · Suggested: {p.action}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Audit trail — timeline of the latest cross-job journal entries. */}
          <Panel id="audit" title="Audit trail" source={audit.source}>
            {audit.available && audit.entries.length > 0 ? (
              <ol>
                {audit.entries.map((e, i) => (
                  <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < audit.entries.length - 1 ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-[3.5px] top-3 h-full w-px bg-border"
                      />
                    ) : null}
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full border-2 border-border-strong bg-surface-raised"
                    />
                    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="font-mono text-xs text-text-muted">{fmtTime(e.ts)}</span>
                      <span className="font-mono text-sm font-semibold text-text">{e.action}</span>
                      <span className="min-w-0 text-sm text-text-muted">{e.summary}</span>
                      <span className="ml-auto text-xs text-text-muted">
                        {e.actorName ?? "—"}
                        {e.actorRole ? ` · ${e.actorRole}` : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState
                title="No recent activity"
                description="The cross-job audit journal has no entries for the current window."
              />
            )}
          </Panel>

          {/* Surface coverage */}
          <Panel id="coverage" title="Surface coverage" source={coverage.note}>
            <div className="overflow-x-auto">
              <div className="min-w-[640px] overflow-hidden rounded-card border border-border bg-surface-raised">
                <div className="grid grid-cols-[1.6fr_0.8fr_repeat(4,0.9fr)] gap-2 border-b border-border bg-surface-subtle px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                  <span>Area</span>
                  <span>Surface</span>
                  <span>Guarded</span>
                  <span>Audit</span>
                  <span>Usage</span>
                  <span>Errors</span>
                </div>
                {coverage.rows.map((r) => (
                  <div
                    key={r.area}
                    className="grid grid-cols-[1.6fr_0.8fr_repeat(4,0.9fr)] items-center gap-2 border-b border-border px-4 py-2.5 last:border-b-0"
                  >
                    <span className="text-sm text-text">{r.area}</span>
                    <span className="text-xs text-text-muted">{r.surface}</span>
                    <CoverageCell value={r.accessGuarded} />
                    <CoverageCell value={r.auditTracked} />
                    <CoverageCell value={r.usageTracked} />
                    <CoverageCell value={r.errorsTracked} />
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 flex items-center gap-4 text-xs text-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                tracked
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full border-2 border-border-strong"
                />
                not tracked
              </span>
            </p>
          </Panel>

          {/* Next actions */}
          <Panel id="actions" title="Next actions" source="Generated from the findings above">
            {nextActions.length === 0 ? (
              <EmptyState title="Nothing queued" description="No next actions derived." />
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
                {nextActions.map((a, i) => (
                  <div key={`${a.title}-${i}`} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip
                        tone={
                          a.priority === "high"
                            ? "danger"
                            : a.priority === "medium"
                              ? "warning"
                              : "info"
                        }
                      >
                        {a.priority}
                      </StatusChip>
                      <span className="font-medium text-text">{a.title}</span>
                      <StatusChip tone={a.safeNow ? "success" : "neutral"} dot={false}>
                        {a.safeNow ? "safe now" : "needs build"}
                      </StatusChip>
                    </div>
                    <p className="mt-1.5 text-sm text-text-muted">{a.reason}</p>
                    <p className="mt-1 text-xs text-text-muted">Issue: {a.suggestedIssue}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ── Local presentational atoms (Tailwind tokens only) ───────────────────────

interface RailItem {
  id: string;
  label: string;
  /** Right-aligned mono count, e.g. "3" or "12/24". */
  count?: string;
  /** Leading status dot. */
  dot?: StatusTone;
}

const RAIL_DOT: Record<StatusTone, string> = {
  neutral: "bg-text-muted",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  navy: "bg-brand-navy",
  yellow: "bg-accent-yellow",
};

function RailDot({ tone }: { tone: StatusTone }) {
  return (
    <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", RAIL_DOT[tone])} />
  );
}

function MetaItem({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-white/50">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 truncate text-white">
        {live ? (
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-yellow" />
        ) : null}
        {value}
      </dd>
    </div>
  );
}

/** A summary tile that jumps to its section — the console's quick nav. */
function JumpTile({
  targetId,
  onJump,
  label,
  value,
  hint,
  dot,
}: {
  targetId: string;
  onJump: (id: string) => void;
  label: string;
  value: string;
  hint?: string;
  dot?: StatusTone;
}) {
  return (
    <a
      href={`#${targetId}`}
      onClick={(e) => {
        e.preventDefault();
        onJump(targetId);
      }}
      className="group rounded-card border border-border bg-surface-raised p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy"
    >
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-text-muted">
        {dot ? <RailDot tone={dot} /> : null}
        <span>{label}</span>
      </p>
      <p className="mt-1.5 truncate font-display text-2xl tabular-nums text-text">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-text-muted">{hint}</p> : null}
    </a>
  );
}

/** Static readout tile (no navigation). */
function Meter({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <p className="truncate text-xs uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums text-text">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

/** Count bar scaled against the real max of its list — honest lengths only. */
function BarRow({
  label,
  count,
  max,
  tone = "navy",
}: {
  label: string;
  count: number;
  max: number;
  tone?: "navy" | "danger";
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 truncate font-mono text-xs text-text sm:w-52">{label}</span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-pill bg-surface-subtle">
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 rounded-pill",
            tone === "danger" ? "bg-rose-500" : "bg-brand-navy",
            pctWidthClass(count, max),
          )}
        />
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-text">
        {count}
      </span>
    </div>
  );
}

function Panel({
  id,
  title,
  source,
  caption,
  children,
}: {
  id: string;
  title: string;
  source: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-14 lg:scroll-mt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h2 id={`${id}-title`} className="font-display text-lg text-text">
          {title}
        </h2>
        <p className="text-xs text-text-muted">Source: {source}</p>
      </div>
      {caption ? <p className="mt-1 max-w-3xl text-xs text-text-muted">{caption}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Probe LED — filled dot with a soft halo, coloured by probe status. */
function ProbeLed({ status }: { status: HealthCheck["status"] }) {
  const cls =
    status === "ok"
      ? "bg-emerald-500 ring-emerald-500/15"
      : status === "warning"
        ? "bg-amber-500 ring-amber-500/15"
        : "bg-rose-500 ring-rose-500/15";
  return (
    <span aria-hidden="true" className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4", cls)} />
  );
}

function CoverageCell({ value }: { value: boolean }) {
  return (
    <span className="flex items-center">
      {value ? (
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
      ) : (
        <span className="h-2.5 w-2.5 rounded-full border-2 border-border-strong" />
      )}
      <span className="sr-only">{value ? "yes" : "no"}</span>
    </span>
  );
}

function NotInstrumented({ items }: { items: ReadonlyArray<string> }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
        Not instrumented yet
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
        {items.map((it) => (
          <li key={it}>· {it}</li>
        ))}
      </ul>
    </div>
  );
}

function fmtTime(iso: string): string {
  // Deterministic, locale-free: "2026-06-28 10:42" from an ISO timestamp.
  if (!iso || iso.length < 16) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
