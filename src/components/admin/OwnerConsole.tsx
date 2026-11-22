import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
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
 * Owner Console (docs/owner-console.md) — one short page, in the order the
 * owner uses it:
 *
 *   1. A navy band: who/where/when + the four headline numbers (each jumps to
 *      its section).
 *   2. "Needs you" — only the real problems (failed probes, expired/expiring
 *      flags, errors this week, access warnings), or an explicit all-clear.
 *   3. Features — the Off · Preview · Live board (the console's main job).
 *   4. Settings, Activity (usage + audit trail merged), Errors, Account.
 *   5. Diagnostics — collapsed: health probes, instrumentation gaps, surface
 *      coverage, next actions. Kept whole, just out of the way.
 *
 * A server component: the board and settings are client islands, everything
 * else is static markup, so every section is in the SSR HTML.
 *
 * Honesty rules (P7): every section names its data source; gaps are labelled
 * "not instrumented", never zero-filled. Bars are scaled to real counts only.
 */
export function OwnerConsole({
  summary,
  account,
}: {
  summary: OwnerSummary;
  /** Owner-account controls (the password card), placed before Diagnostics. */
  account?: ReactNode;
}) {
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

  const product = flags.items.filter((f) => !f.protected);
  const liveCount = product.filter((f) => f.resolved).length;
  const previewCount = product.filter((f) => !f.resolved && f.resolvedForOwner).length;
  const hasSettings = !!settings && settings.items.length > 0;
  const errorCount7d = errors?.available ? errors.count7d : 0;

  // "Needs you": real, actionable signals only. Instrumentation gaps are
  // permanent bookkeeping, not attention — they live in Diagnostics.
  const attention: Attention[] = sortProblems(problems)
    .filter((p) => p.severity !== "not_instrumented")
    .map((p) => ({
      tone: severityTone(p.severity),
      tag: severityLabel(p.severity),
      title: p.title,
      why: p.why,
      fix: p.action,
      evidence: p.evidence,
    }));
  if (errorCount7d > 0 && errors?.available) {
    const top = errors.topGroups[0];
    attention.push({
      tone: "warning",
      tag: "errors",
      title: `${errorCount7d} error${errorCount7d === 1 ? "" : "s"} in the last 7 days`,
      why: top ? `Most frequent: ${top.handler} — ${top.message}` : "See the Errors section.",
      fix: "Open the Errors section below for the grouped list.",
      href: "#errors",
    });
  }

  const gapProblems = problems.filter((p) => p.severity === "not_instrumented");
  const gaps = dedupe([...health.notInstrumented, ...usage.notInstrumented]);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* ── Band: identity + headline numbers ─────────────────────────── */}
      <section
        id="overview"
        aria-label="Overview"
        className="overflow-hidden rounded-card bg-brand-navy shadow-raised"
      >
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-2xl text-white">Platform control</h2>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-white/70">
                <span className="inline-flex items-center gap-1.5">
                  {meta.environment === "production" ? (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-accent-yellow"
                    />
                  ) : null}
                  {meta.environment}
                </span>
                <Sep />
                <span>{meta.viewer.name ?? meta.viewer.email ?? meta.viewer.role ?? "—"}</span>
                <Sep />
                <span>
                  via {meta.identityBasis === "owner-role" ? "owner role" : "email allowlist"}
                </span>
                <Sep />
                <span>loaded {fmtTime(meta.asOf)}</span>
              </p>
            </div>
            {capabilities.flagToggle ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-accent-yellow px-2.5 py-1 text-xs font-semibold text-brand-navy">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-navy" />
                Owner controls
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center rounded-pill border border-white/25 px-2.5 py-1 text-xs font-semibold text-white/80">
                Read-only
              </span>
            )}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/10 pt-4 sm:grid-cols-4">
            <BandStat
              label="Health"
              value={healthLabel(health.overall)}
              dot={healthTone(health.overall)}
            />
            <BandStat
              label="Features"
              value={`${liveCount} live`}
              hint={`${previewCount} preview · ${product.length - liveCount - previewCount} off`}
              href="#features"
            />
            <BandStat
              label="Activity · 7 days"
              value={`${usage.auditEvents7d} events`}
              hint={`${usage.distinctActors7d} ${usage.distinctActors7d === 1 ? "person" : "people"}`}
              href="#activity"
            />
            <BandStat
              label="Errors · 7 days"
              value={errors ? String(errorCount7d) : "—"}
              hint={errors ? (errors.available ? `${errors.total} recorded` : "none recorded") : "unavailable"}
              dot={errorCount7d > 0 ? "danger" : undefined}
              href="#errors"
            />
          </div>
        </div>
      </section>

      {/* ── Needs you ─────────────────────────────────────────────────── */}
      <section id="needs-you" aria-labelledby="needs-you-title">
        <h2 id="needs-you-title" className="font-display text-lg text-text">
          Needs you
          {attention.length > 0 ? (
            <span className="ml-2 font-mono text-sm tabular-nums text-text-muted">
              {attention.length}
            </span>
          ) : null}
        </h2>
        {attention.length === 0 ? (
          <p
            data-testid="owner-all-clear"
            className="mt-3 flex items-center gap-2 rounded-card border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          >
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            All clear — probes pass, no errors this week, every feature flag in date.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
            {attention.map((a, i) => (
              <li key={`${a.title}-${i}`} className="flex gap-3 px-4 py-3.5">
                <Dot tone={a.tone} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text">
                      {a.href ? (
                        <a href={a.href} className="hover:underline">
                          {a.title}
                        </a>
                      ) : (
                        a.title
                      )}
                    </span>
                    <StatusChip tone={a.tone} dot={false}>
                      {a.tag}
                    </StatusChip>
                  </div>
                  <p className="mt-1 text-sm text-text-muted">{a.why}</p>
                  <p className="mt-1 text-sm text-text">
                    <span className="text-text-muted">Fix: </span>
                    {a.fix}
                  </p>
                  {a.evidence ? (
                    <p className="mt-0.5 text-xs text-text-muted">Evidence: {a.evidence}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Features ──────────────────────────────────────────────────── */}
      <Section
        id="features"
        title="Features"
        source={flags.source}
        caption={
          capabilities.flagToggle
            ? undefined
            : `Read-only — ${capabilities.flagToggleReason}`
        }
      >
        {flags.items.length === 0 ? (
          <Quiet>{flags.error ?? "The flag registry returned nothing."}</Quiet>
        ) : capabilities.flagToggle ? (
          <div className="space-y-3">
            {meta.identityBasis === "email-allowlist" ? (
              <div
                role="note"
                className="rounded-card border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
              >
                You&rsquo;re signed in via the email allowlist, not the{" "}
                <span className="font-mono">owner</span> role. Live and Off work, but{" "}
                <strong>Preview</strong> only takes effect in the app when your account has the{" "}
                <span className="font-mono">owner</span> role.
              </div>
            ) : null}
            <OwnerFeatureBoard items={flags.items} rev={flags.rev} />
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
            {flags.items.map((f) => (
              <li key={f.key} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text">{f.label || f.key}</span>
                  <span className="font-mono text-[11px] text-text-muted">{f.key}</span>
                  <StatusChip tone={flagStateTone(f.resolved)}>{f.resolved ? "On" : "Off"}</StatusChip>
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
                  {flagSourceLabel(f.source)} · {f.target} · expires {f.expires} · default{" "}
                  {f.default ? "on" : "off"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Settings ──────────────────────────────────────────────────── */}
      {hasSettings ? (
        <Section
          id="settings"
          title="Feature settings"
          source={settings.source}
          caption={
            capabilities.settingsWrite
              ? "Each default is the live value until you change it."
              : "Read-only."
          }
        >
          {capabilities.settingsWrite ? (
            <OwnerSettingsControls items={settings.items} rev={settings.rev} />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
              {settings.items.map((s) => (
                <li key={`${s.featureKey}.${s.key}`} className="space-y-1 px-4 py-3">
                  <p className="text-sm font-medium text-text">{s.label}</p>
                  <p className="text-xs text-text-muted">
                    <span className="font-mono">
                      {s.featureKey}.{s.key}
                    </span>{" "}
                    · {String(s.value)}
                    {s.unit ? ` ${s.unit}` : ""} · default {String(s.default)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {/* ── Activity (usage + audit trail) ───────────────────────────── */}
      <Section id="activity" title="Activity" source={`${usage.source}; ${audit.source}`}>
        <p className="text-sm text-text">
          <strong className="tabular-nums">{usage.auditEvents7d}</strong> events by{" "}
          <strong className="tabular-nums">{usage.distinctActors7d}</strong>{" "}
          {usage.distinctActors7d === 1 ? "person" : "people"} in the last 7 days
          <span className="text-text-muted">
            {" "}
            · {usage.monthEntryCount} this month (cap {usage.monthCap})
          </span>
        </p>

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="rounded-card border border-border bg-surface-raised p-4">
            <p className="text-xs font-semibold text-text-muted">Top actions · 7 days</p>
            {usage.topActions.length > 0 ? (
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
            ) : (
              <p className="mt-2 text-sm text-text-muted">No activity recorded in the last 7 days.</p>
            )}
          </div>

          <div className="rounded-card border border-border bg-surface-raised p-4">
            <p className="text-xs font-semibold text-text-muted">Latest in the audit trail</p>
            {audit.available && audit.entries.length > 0 ? (
              <>
                <AuditList entries={audit.entries.slice(0, RECENT_SHOWN)} />
                {audit.entries.length > RECENT_SHOWN ? (
                  <details className="group mt-2">
                    <summary className="cursor-pointer list-none select-none text-sm font-medium text-brand-navy hover:underline [&::-webkit-details-marker]:hidden">
                      <span className="group-open:hidden">
                        Show {audit.entries.length - RECENT_SHOWN} more
                      </span>
                      <span className="hidden group-open:inline">Show fewer</span>
                    </summary>
                    <AuditList entries={audit.entries.slice(RECENT_SHOWN)} />
                  </details>
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-sm text-text-muted">
                No recent activity — the audit journal has no entries for this window.
              </p>
            )}
          </div>
        </div>
      </Section>

      {/* ── Errors (#154) ─────────────────────────────────────────────── */}
      <Section
        id="errors"
        title="Errors"
        source={errors?.source ?? "platform error journal (platform/errors.json)"}
        caption={errors?.coverageNote}
      >
        {!errors ? (
          <Quiet>Errors panel unavailable — the owner endpoint did not return this section.</Quiet>
        ) : !errors.available ? (
          <p className="flex items-center gap-2 rounded-card border border-border bg-surface-raised px-4 py-3 text-sm text-text-muted">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            No errors recorded yet.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-text">
              <strong className="tabular-nums">{errors.count7d}</strong> in the last 7 days
              <span className="text-text-muted">
                {" "}
                · {errors.total} recorded (cap {errors.cap})
              </span>
            </p>
            {errors.topGroups.length > 0 ? (
              <div className="rounded-card border border-border bg-surface-raised p-4">
                <p className="text-xs font-semibold text-text-muted">Most frequent</p>
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
              <Disclosure label={`Recent events (${errors.recent.length})`}>
                <ul className="divide-y divide-border">
                  {errors.recent.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                    >
                      <span className="font-mono text-xs text-text-muted">{fmtTime(e.ts)}</span>
                      <span className="font-mono text-sm font-semibold text-text">{e.handler}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                        {e.message}
                      </span>
                      <span className="ml-auto text-xs text-text-muted">
                        {e.source}
                        {e.statusCode != null ? ` · ${e.statusCode}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </div>
        )}
      </Section>

      {account ? (
        <section id="account" aria-label="Account">
          {account}
        </section>
      ) : null}

      {/* ── Diagnostics (collapsed) ───────────────────────────────────── */}
      <details
        id="diagnostics"
        data-testid="owner-diagnostics"
        className="group rounded-card border border-border bg-surface-raised"
      >
        <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3 hover:bg-surface-subtle">
          <span>
            <span className="font-display text-lg text-text">Diagnostics</span>
            <span className="ml-2 text-sm text-text-muted">
              health probes · instrumentation gaps · coverage · next actions
            </span>
          </span>
          <span
            aria-hidden="true"
            className="text-text-muted transition-transform group-open:rotate-180"
          >
            ▾
          </span>
        </summary>

        <div className="space-y-6 border-t border-border p-4">
          <SubSection title="Product health" source="Live probes at load — Blob, session key, flag expiry">
            <ul className="grid gap-2 sm:grid-cols-2">
              {health.checks.map((c) => (
                <li
                  key={c.id}
                  className="flex items-start gap-3 rounded-card border border-border px-3 py-2.5"
                >
                  <ProbeLed status={c.status} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                      {c.label}
                      {c.status !== "ok" ? (
                        <StatusChip tone={c.status === "warning" ? "warning" : "danger"} dot={false}>
                          {c.status}
                        </StatusChip>
                      ) : null}
                    </p>
                    <p className="text-sm text-text-muted">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </SubSection>

          {gaps.length + gapProblems.length > 0 ? (
            <SubSection title="Not instrumented yet" source="Named gaps — nothing here is zero-filled">
              {gapProblems.length > 0 ? (
                <ul className="space-y-2.5">
                  {gapProblems.map((p) => (
                    <li key={p.title} className="text-sm">
                      <p className="font-medium text-text">{p.title}</p>
                      <p className="text-text-muted">{p.why}</p>
                      <p className="text-xs text-text-muted">
                        Evidence: {p.evidence} · Suggested: {p.action}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {gaps.length > 0 ? (
                <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
                  {gaps.map((g) => (
                    <li key={g}>· {g}</li>
                  ))}
                </ul>
              ) : null}
            </SubSection>
          ) : null}

          <SubSection title="Surface coverage" source={coverage.note}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3 font-semibold">Area</th>
                    <th className="py-2 pr-3 font-semibold">Surface</th>
                    <th className="py-2 pr-3 font-semibold">Guarded</th>
                    <th className="py-2 pr-3 font-semibold">Audit</th>
                    <th className="py-2 pr-3 font-semibold">Usage</th>
                    <th className="py-2 font-semibold">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.rows.map((r) => (
                    <tr key={r.area} className="border-b border-border last:border-b-0">
                      <td className="py-2 pr-3 text-text">{r.area}</td>
                      <td className="py-2 pr-3 text-xs text-text-muted">{r.surface}</td>
                      <CoverageCell value={r.accessGuarded} />
                      <CoverageCell value={r.auditTracked} />
                      <CoverageCell value={r.usageTracked} />
                      <CoverageCell value={r.errorsTracked} />
                    </tr>
                  ))}
                </tbody>
              </table>
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
          </SubSection>

          <SubSection title="Next actions" source="Generated from the findings above">
            {nextActions.length === 0 ? (
              <p className="text-sm text-text-muted">Nothing queued.</p>
            ) : (
              <ul className="divide-y divide-border">
                {nextActions.map((a, i) => (
                  <li key={`${a.title}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
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
                      <span className="text-sm font-medium text-text">{a.title}</span>
                      <StatusChip tone={a.safeNow ? "success" : "neutral"} dot={false}>
                        {a.safeNow ? "safe now" : "needs build"}
                      </StatusChip>
                    </div>
                    <p className="mt-1 text-sm text-text-muted">{a.reason}</p>
                    <p className="mt-0.5 text-xs text-text-muted">Issue: {a.suggestedIssue}</p>
                  </li>
                ))}
              </ul>
            )}
          </SubSection>
        </div>
      </details>
    </div>
  );
}

// ── Local presentational atoms (Tailwind tokens only) ───────────────────────

const RECENT_SHOWN = 6;

interface Attention {
  tone: StatusTone;
  tag: string;
  title: string;
  why: string;
  fix: string;
  evidence?: string;
  href?: string;
}

const DOT: Record<StatusTone, string> = {
  neutral: "bg-text-muted",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  navy: "bg-brand-navy",
  yellow: "bg-accent-yellow",
};

function Dot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-2 w-2 shrink-0 rounded-full", DOT[tone], className)}
    />
  );
}

function Sep() {
  return (
    <span aria-hidden="true" className="text-white/30">
      ·
    </span>
  );
}

/** A headline number in the band; with `href` it jumps to its section. */
function BandStat({
  label,
  value,
  hint,
  dot,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  dot?: StatusTone;
  href?: string;
}) {
  const body = (
    <>
      <span className="block text-xs text-white/55">{label}</span>
      <span className="mt-0.5 flex items-center gap-1.5 font-display text-xl tabular-nums text-white">
        {dot ? <Dot tone={dot} /> : null}
        <span className="truncate">{value}</span>
      </span>
      {hint ? <span className="block truncate text-xs text-white/55">{hint}</span> : null}
    </>
  );
  return href ? (
    <a
      href={href}
      className="-m-2 block min-w-0 rounded-card p-2 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-yellow"
    >
      {body}
    </a>
  ) : (
    <div className="min-w-0">{body}</div>
  );
}

function Section({
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
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-4">
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

function SubSection({
  title,
  source,
  children,
}: {
  title: string;
  source: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <p className="mb-2 text-xs text-text-muted">Source: {source}</p>
      {children}
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-card border border-dashed border-border bg-surface-subtle px-4 py-3 text-sm text-text-muted">
      {children}
    </p>
  );
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-card border border-border bg-surface-raised">
      <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-2.5 text-sm font-medium text-text hover:bg-surface-subtle">
        {label}
        <span aria-hidden="true" className="text-text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}

function AuditList({ entries }: { entries: OwnerSummary["audit"]["entries"] }) {
  return (
    <ul className="mt-2 divide-y divide-border">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
          <span className="font-mono text-xs text-text-muted">{fmtTime(e.ts)}</span>
          <span className="font-mono text-xs font-semibold text-text">{e.action}</span>
          <span className="min-w-0 flex-1 text-sm text-text-muted">{e.summary}</span>
          <span className="text-xs text-text-muted">
            {e.actorName ?? "—"}
            {e.actorRole ? ` · ${e.actorRole}` : ""}
          </span>
        </li>
      ))}
    </ul>
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
      <span className="w-32 truncate font-mono text-xs text-text sm:w-44">{label}</span>
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
    <td className="py-2 pr-3">
      {value ? (
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
      ) : (
        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-border-strong" />
      )}
      <span className="sr-only">{value ? "yes" : "no"}</span>
    </td>
  );
}

function dedupe(items: ReadonlyArray<string>): string[] {
  return Array.from(new Set(items));
}

function fmtTime(iso: string): string {
  // Deterministic, locale-free: "2026-06-28 10:42" from an ISO timestamp.
  if (!iso || iso.length < 16) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
