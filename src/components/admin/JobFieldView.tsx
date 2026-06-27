import {
  AlertOctagon,
  AlertTriangle,
  Camera,
  Eye,
  Inbox,
  Lock,
  Navigation,
  ShieldAlert,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  buildPhilJobCommandModel,
  type PhilJobAttentionItem,
  type PhilJobCommandAction,
} from "@/domains/phil/job-command-model";
import {
  philJobCommandInputFromJobData,
  type PhilJobDataForCommand,
} from "@/domains/phil/job-command-input";
import { buildPhilPreview } from "@/domains/jobs/builder";

/**
 * Admin "Field view" of a job — a READ-ONLY render of exactly what the crew
 * sees in Phil (the audit's "one app" test). It consumes the SAME pure read
 * model the field app builds (buildPhilJobCommandModel) + the same structural
 * preview (buildPhilPreview), rendered with admin/ui primitives.
 *
 * It deliberately does NOT import PhilShell or PhilJobDetail: the latter calls
 * useCaptureLauncher(), which throws outside the Phil provider and would crash
 * the admin page (the shell-contract guard only catches the PhilShell import,
 * not this runtime trap). Lifting the render into this admin component is the
 * sanctioned path.
 *
 * Truth over theatre (P7): there is no four-state stage stepper or foreman
 * briefing in the data, so we don't fake one — stages/areas render as the real
 * structure + task counts, and the "what now" + attention + capability rows
 * come straight from the model (which marks unknowns as honest limitations).
 * The capture shutter is rendered disabled — the admin looks AT the crew view,
 * never acts as the worker.
 */

interface JobFieldViewProps {
  data: PhilJobDataForCommand;
  /** First name of the lead/foreman for the banner, when known. */
  leadFirstName?: string | null;
}

export function JobFieldView({ data, leadFirstName }: JobFieldViewProps) {
  const model = buildPhilJobCommandModel(philJobCommandInputFromJobData(data));
  const preview = buildPhilPreview(data.job);

  const whoSeesIt = leadFirstName?.trim() || "the crew";

  return (
    <div className="space-y-4">
      {/* Read-only banner */}
      <div className="flex items-center gap-3 rounded-card bg-brand-navy px-4 py-3 text-text-inverse">
        <Eye aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-yellow" />
        <div className="min-w-0">
          <p className="font-display text-sm font-semibold">Field view — what the crew sees</p>
          <p className="text-xs text-text-inverse/70">
            What {whoSeesIt} sees in Phil for this job · read-only
          </p>
        </div>
      </div>

      <WhatNow model={model} />

      {/* Attention — issues/blockers in field language */}
      {model.attention.length > 0 ? (
        <section>
          <FieldSectionLabel>On site</FieldSectionLabel>
          <Card className="mt-2 space-y-2 p-3">
            {model.attention.map((a) => (
              <AttentionRow key={a.id} item={a} />
            ))}
          </Card>
        </section>
      ) : null}

      {preview.emptyReason ? (
        <Card className="border-dashed p-4">
          <p className="text-sm text-text-muted">{preview.emptyReason}</p>
          <p className="mt-1 text-sm text-text-muted">
            The crew can still capture photos, log hours and raise issues — structure gets added in
            the builder.
          </p>
        </Card>
      ) : (
        <>
          {/* Work · stages — the real plan (counts only; no fabricated state). */}
          {preview.stages.length > 0 ? (
            <section>
              <FieldSectionLabel>Work · stages</FieldSectionLabel>
              <Card className="mt-2 divide-y divide-border p-0">
                {preview.stages.map((s, i) => (
                  <div key={s.stage} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-surface-subtle font-display text-xs font-bold text-text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-sm font-semibold text-text">
                        {s.label}
                      </span>
                      <span className="block text-xs text-text-muted">
                        {s.jobLevelTaskCount} task{s.jobLevelTaskCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </div>
                ))}
              </Card>
            </section>
          ) : null}

          {/* Areas — name + level + the tasks the crew sees there. */}
          {preview.areas.length > 0 ? (
            <section>
              <FieldSectionLabel>Areas · {preview.areas.length}</FieldSectionLabel>
              <Card className="mt-2 divide-y divide-border p-0">
                {preview.areas.map((a, i) => (
                  <div key={`${a.groupName}-${a.areaName}-${i}`} className="px-4 py-3">
                    <p className="font-display text-sm font-semibold text-text">
                      {a.areaName}{" "}
                      <span className="font-normal text-text-muted">· {a.groupName}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {a.roughInTasks.length} rough-in · {a.fitOffTasks.length} fit-off
                    </p>
                  </div>
                ))}
              </Card>
            </section>
          ) : null}
        </>
      )}

      {/* On this job — the real capability rows from the command model. */}
      {model.primaryAction || model.actions.length > 0 ? (
        <section>
          <FieldSectionLabel>What the crew can do</FieldSectionLabel>
          <Card className="mt-2 divide-y divide-border p-0">
            {(model.primaryAction ? [model.primaryAction] : []).concat(model.actions).map((act) => (
              <ActionRow key={act.id} action={act} />
            ))}
          </Card>
        </section>
      ) : null}

      {/* Honest limitations — what Phil can't show/do here yet. */}
      {model.limitations.length > 0 ? (
        <Card className="space-y-1 border-dashed p-3">
          {model.limitations.map((l) => (
            <p key={l.id} className="text-xs text-text-muted">
              <Lock aria-hidden="true" className="mr-1 inline h-3 w-3 align-text-bottom" />
              {l.label}
              {l.reason ? ` — ${l.reason}` : ""}
            </p>
          ))}
        </Card>
      ) : null}

      {/* Capture shutter — the worker's primary action, rendered DISABLED
          (the admin is looking at the crew view, not acting as the worker). */}
      <div
        aria-disabled="true"
        title="Read-only — this is the crew's capture button"
        className="flex w-full cursor-not-allowed items-center gap-3 rounded-card bg-accent-yellow/60 px-4 py-3 text-brand-navy"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-navy/80 text-accent-yellow">
          <Camera aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block font-display text-sm font-bold">Capture</span>
          <span className="block text-xs opacity-70">The crew captures proof here · read-only</span>
        </span>
      </div>

      <p className="rounded-card bg-surface-subtle p-3 text-xs text-text-muted">
        This is the crew&rsquo;s screen. They do the work, capture proof and complete the ITP here —
        on the field model, completing the ITP is the sign-off, not an office approval.
      </p>
    </div>
  );
}

function WhatNow({ model }: { model: ReturnType<typeof buildPhilJobCommandModel> }) {
  if (model.state === "error") {
    return (
      <ToneCard tone="danger" eyebrow="Couldn’t load" icon={AlertOctagon}>
        {model.attention[0]?.label ?? "This job couldn’t load for the field."}
      </ToneCard>
    );
  }
  if (model.state === "office_only") {
    return (
      <ToneCard tone="neutral" eyebrow="Not published" icon={Lock}>
        {model.attention[0]?.label ?? "Office-only — the crew can’t open this job in Phil yet."}
      </ToneCard>
    );
  }
  if (model.state === "blocked") {
    const blocked = model.attention.find((a) => a.severity === "blocked");
    const onHold = model.attention.some((a) => a.id === "on-hold");
    return (
      <ToneCard
        tone="danger"
        eyebrow={onHold ? "Safety hold" : "Blocked"}
        icon={ShieldAlert}
        sub={blocked?.reason}
      >
        {blocked?.label ?? "Blocked — needs sorting before work continues."}
      </ToneCard>
    );
  }
  if (model.state === "empty") {
    return (
      <ToneCard tone="navy" eyebrow="Next on this job" icon={Navigation}>
        Nothing set up to do yet — capture, hours and issues are still available.
      </ToneCard>
    );
  }
  // ready — amber if there's a heads-up, else navy with the primary action.
  const warn = model.attention.find((a) => a.severity === "warning" || a.severity === "blocked");
  if (warn) {
    return (
      <ToneCard tone="warning" eyebrow="Heads up" icon={AlertTriangle} sub={warn.reason}>
        {warn.label}
      </ToneCard>
    );
  }
  return (
    <ToneCard tone="navy" eyebrow="Next on this job" icon={Navigation}>
      {model.primaryAction?.label ?? "Up to date — nothing waiting."}
    </ToneCard>
  );
}

const TONE_BG: Record<"danger" | "warning" | "navy" | "neutral", string> = {
  danger: "bg-state-danger text-text-inverse",
  warning: "bg-state-warning text-text-inverse",
  navy: "bg-brand-navy text-text-inverse",
  neutral: "bg-surface-subtle text-text",
};

function ToneCard({
  tone,
  eyebrow,
  icon: Icon,
  sub,
  children,
}: {
  tone: "danger" | "warning" | "navy" | "neutral";
  eyebrow: string;
  icon: typeof Navigation;
  sub?: string;
  children: React.ReactNode;
}) {
  const onDark = tone !== "neutral";
  return (
    <div className={cn("rounded-card px-4 py-4", TONE_BG[tone])}>
      <p
        className={cn(
          "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
          onDark ? "text-text-inverse/80" : "text-text-muted",
        )}
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {eyebrow}
      </p>
      <p className="mt-1.5 font-display text-base font-semibold leading-snug">{children}</p>
      {sub ? (
        <p className={cn("mt-1 text-xs", onDark ? "text-text-inverse/70" : "text-text-muted")}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

const ATTN_TONE: Record<PhilJobAttentionItem["severity"], string> = {
  blocked: "border-l-state-danger",
  warning: "border-l-state-warning",
  info: "border-l-state-info",
};

function AttentionRow({ item }: { item: PhilJobAttentionItem }) {
  return (
    <div className={cn("border-l-[3px] pl-3", ATTN_TONE[item.severity])}>
      <p className="text-sm font-medium text-text">{item.label}</p>
      {item.reason ? <p className="text-xs text-text-muted">{item.reason}</p> : null}
    </div>
  );
}

const ACTION_STATUS_TONE: Record<PhilJobCommandAction["status"], "success" | "warning" | "neutral"> = {
  ready: "success",
  attention: "warning",
  disabled: "neutral",
  not_configured: "neutral",
};
const ACTION_STATUS_LABEL: Record<PhilJobCommandAction["status"], string> = {
  ready: "ready",
  attention: "needs you",
  disabled: "off",
  not_configured: "not set up",
};

function ActionRow({ action }: { action: PhilJobCommandAction }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Inbox aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text">{action.label}</span>
        {action.reason ? <span className="block text-xs text-text-muted">{action.reason}</span> : null}
      </span>
      <Pill tone={ACTION_STATUS_TONE[action.status]}>{ACTION_STATUS_LABEL[action.status]}</Pill>
    </div>
  );
}

function FieldSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 font-mono text-[11px] font-semibold uppercase tracking-widest text-text-muted">
      {children}
    </h3>
  );
}
