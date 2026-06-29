import type { ReactNode } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { StatusChip } from "@/components/ui/StatusChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { OwnerFlagList } from "@/components/admin/OwnerFlagRow";
import { OwnerSettingsControls } from "@/components/admin/OwnerSettingsControls";
import {
  type OwnerSummary,
  checkTone,
  coverageTone,
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
 * Owner Console board (docs/owner-console.md) — server render of the owner-gated
 * summary from /api/owner. The page resolves access + data server-side and hands
 * a parsed `OwnerSummary` here. The only interactive part is the feature-flag
 * section, which mounts the OwnerFlagList client island when
 * capabilities.flagToggle is true (writes go to POST /api/owner-flags); when
 * false it falls back to the read-only flag list.
 *
 * Honesty rules (P7): every panel shows its data source + freshness, or an
 * explicit "not instrumented yet" label. No fake metrics, no invented zeros,
 * no vanity numbers.
 */
export function OwnerConsole({ summary }: { summary: OwnerSummary }) {
  const { meta, capabilities, health, flags, settings, usage, audit, coverage, problems, nextActions } =
    summary;

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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Header */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Platform control</CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Private control surface for app health, usage, feature flags, and product
              risk. Owner-only
              {capabilities.flagToggle
                ? " — switch features off for customers and preview unbuilt work live."
                : " — read-only in this first slice."}
            </CardDescription>
          </div>
          <StatusChip tone="navy">{capabilities.flagToggle ? "Owner controls" : "Read-only"}</StatusChip>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <MetaItem label="Environment" value={meta.environment} />
          <MetaItem
            label="Access via"
            value={meta.identityBasis === "owner-role" ? "owner role" : "email allowlist"}
          />
          <MetaItem label="Signed in" value={meta.viewer.name ?? meta.viewer.email ?? meta.viewer.role ?? "—"} />
          <MetaItem label="Loaded" value={fmtTime(meta.asOf)} />
        </dl>
      </Card>

      {/* Summary strip */}
      <section aria-label="Summary">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Health" value={healthLabel(health.overall)} tone={healthTone(health.overall)} />
          <StatCard label="Activity (7d)" value={String(usage.auditEvents7d)} hint="audit events" />
          <StatCard
            label="Flags on"
            value={`${onCount}/${flags.items.length}`}
            hint={expiredCount ? `${expiredCount} expired` : "all in date"}
            tone={expiredCount ? "danger" : "neutral"}
          />
          <StatCard
            label="Problems"
            value={String(problems.length)}
            hint={blockerHigh ? `${blockerHigh} high+` : "none high"}
            tone={blockerHigh ? "warning" : "neutral"}
          />
          <StatCard label="Instrumentation gaps" value={String(gapCount)} hint="not wired yet" />
        </div>
      </section>

      {/* Product Health */}
      <Section title="Product health" source="Live probes at load — Blob, session key, flag expiry">
        <div className="space-y-2">
          {health.checks.map((c) => (
            <Row key={c.id}>
              <div className="min-w-0">
                <p className="font-medium text-text">{c.label}</p>
                <p className="text-sm text-text-muted">{c.detail}</p>
              </div>
              <StatusChip tone={checkTone(c.status)}>{c.status}</StatusChip>
            </Row>
          ))}
        </div>
        <NotInstrumented items={health.notInstrumented} />
      </Section>

      {/* Usage & Activity */}
      <Section title="Usage & activity" source={usage.source}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Events (7d)" value={String(usage.auditEvents7d)} />
          <StatCard label="Active people (7d)" value={String(usage.distinctActors7d)} />
          <StatCard label="Events this month" value={String(usage.monthEntryCount)} hint={`cap ${usage.monthCap}`} />
          <StatCard label="Top actions" value={String(usage.topActions.length)} hint="see below" />
        </div>
        {usage.topActions.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {usage.topActions.map((a) => (
              <Row key={a.action}>
                <span className="font-mono text-sm text-text">{a.action}</span>
                <StatusChip tone="neutral" dot={false}>
                  {a.count}
                </StatusChip>
              </Row>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-text-muted">No activity recorded in the last 7 days.</p>
        )}
        <NotInstrumented items={usage.notInstrumented} />
      </Section>

      {/* Feature Flags */}
      <Section
        title="Feature flags"
        source={flags.source}
        caption={
          capabilities.flagToggle
            ? `${onCount} on · ${expiredCount} expired · ${expiringCount} expiring soon · two dials per flag — Live to customers + Preview for me. Protected data-plane flags stay read-only.`
            : `${onCount} on · ${expiredCount} expired · ${expiringCount} expiring soon · read-only (${capabilities.flagToggleReason})`
        }
      >
        {flags.items.length === 0 ? (
          <EmptyState title="No flags resolved" description={flags.error ?? "The flag registry returned nothing."} />
        ) : capabilities.flagToggle ? (
          <div className="space-y-3">
            {meta.identityBasis === "email-allowlist" ? (
              <div
                role="note"
                className="rounded-card border-l-2 border-l-state-warning bg-surface-raised px-4 py-2 text-sm text-text"
              >
                You&rsquo;re signed in via the email allowlist, not the{" "}
                <span className="font-mono">owner</span> role. Customer toggles work, but{" "}
                <strong>Preview for me</strong> only takes effect in the live app when your account has
                the <span className="font-mono">owner</span> role.
              </div>
            ) : null}
            <OwnerFlagList items={flags.items} rev={flags.rev} />
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {flags.items.map((f) => (
              <div key={f.key} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-text">{f.key}</span>
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
                  source: {flagSourceLabel(f.source)} · target: {f.target} · expires {f.expires} ·{" "}
                  default {f.default ? "on" : "off"} · {f.toggleable ? "toggleable" : "read-only"}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Feature configuration (#760 PR2) */}
      {settings && settings.items.length > 0 ? (
        <Section
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
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
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
        </Section>
      ) : null}

      {/* Product Problems */}
      <Section title="Product problems" source="Derived from real signals — flag expiry, health probes, instrumentation gaps">
        {problems.length === 0 ? (
          <EmptyState title="Nothing flagged" description="No problems derived from current signals." />
        ) : (
          <div className="space-y-2">
            {sortProblems(problems).map((p, i) => (
              <div key={`${p.title}-${i}`} className="rounded-card border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={severityTone(p.severity)}>{severityLabel(p.severity)}</StatusChip>
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
      </Section>

      {/* Audit Trail */}
      <Section title="Audit trail" source={audit.source}>
        {audit.available && audit.entries.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {audit.entries.map((e) => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="font-mono text-xs text-text-muted">{fmtTime(e.ts)}</span>
                <span className="font-mono text-sm font-semibold text-text">{e.action}</span>
                <span className="text-sm text-text-muted">{e.summary}</span>
                <span className="ml-auto text-xs text-text-muted">
                  {e.actorName ?? "—"}
                  {e.actorRole ? ` · ${e.actorRole}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No recent activity"
            description="The cross-job audit journal has no entries for the current window."
          />
        )}
      </Section>

      {/* Surface Coverage */}
      <Section title="Surface coverage" source={coverage.note}>
        <div className="overflow-x-auto">
          <div className="min-w-[640px] overflow-hidden rounded-card border border-border">
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
                className="grid grid-cols-[1.6fr_0.8fr_repeat(4,0.9fr)] items-center gap-2 border-b border-border px-4 py-2 last:border-b-0"
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
      </Section>

      {/* Next Actions */}
      <Section title="Next actions" source="Generated from the findings above">
        {nextActions.length === 0 ? (
          <EmptyState title="Nothing queued" description="No next actions derived." />
        ) : (
          <div className="space-y-2">
            {nextActions.map((a, i) => (
              <div key={`${a.title}-${i}`} className="rounded-card border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={a.priority === "high" ? "danger" : a.priority === "medium" ? "warning" : "info"}>
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
      </Section>
    </div>
  );
}

// ── Local presentational atoms (Tailwind tokens only; no inline styles) ─────

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Parameters<typeof StatusChip>[0]["tone"];
}) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-4">
      <p className="text-xs uppercase tracking-wider text-text-muted">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-xl text-text">{value}</span>
        {tone !== "neutral" ? <StatusChip tone={tone} dot={false}>{hint ?? ""}</StatusChip> : null}
      </div>
      {hint && tone === "neutral" ? <p className="mt-0.5 text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

function Section({
  title,
  source,
  caption,
  children,
}: {
  title: string;
  source: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mt-1 text-xs text-text-muted">Source: {source}</p>
      {caption ? <p className="mt-0.5 text-xs text-text-muted">{caption}</p> : null}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 rounded-card border border-border px-4 py-2.5">{children}</div>;
}

function CoverageCell({ value }: { value: boolean }) {
  return (
    <span>
      <StatusChip tone={coverageTone(value)} dot={false}>
        {value ? "yes" : "no"}
      </StatusChip>
    </span>
  );
}

function NotInstrumented({ items }: { items: ReadonlyArray<string> }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 rounded-card border border-dashed border-border bg-surface-subtle p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Not instrumented yet</p>
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
