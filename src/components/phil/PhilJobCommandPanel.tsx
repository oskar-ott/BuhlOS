import type { ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertOctagon,
  AlertTriangle,
  Camera,
  ChevronRight,
  ClipboardCheck,
  Clock,
  ListChecks,
  Map as MapIcon,
  ShieldCheck,
} from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { PhilNotice } from "./ui/PhilNotice";
import { cn } from "@/lib/cn";
import type {
  PhilJobActionId,
  PhilJobCommandAction,
  PhilJobCommandModel,
} from "@/domains/phil/job-command-model";

/**
 * Phil — "Quick actions" command panel.
 *
 * The worker-first surface for *"what are the fastest things I might need on this
 * job?"* — presented as the worker's shortcuts, not the app's orders. (The
 * heading was reframed from "Next on this job" to drop the digital-foreman feel;
 * the model still ranks a primary action internally — the framing changed, the
 * logic did not.) It renders **only** from a {@link PhilJobCommandModel} produced by
 * `buildPhilJobCommandModel` (the pure decision layer, #96) — it never inspects
 * raw job / evidence / hours / task data, so when a capability changes the
 * bridge moves and this panel stays put.
 *
 * What it shows (all from the model):
 *   - a hard blocker (e.g. on hold) as a calm notice — and no primary action,
 *     so we never lead a worker into work on a blocked job;
 *   - the single `primaryAction` as the prominent CTA;
 *   - the ranked secondary `actions` as compact rows;
 *   - honest `limitations` as muted one-liners.
 *
 * What it deliberately does NOT show: the model's info/warning `attention`
 * array. The job page already renders the richer, viewer-scoped
 * `PhilJobAttentionStrip` ("assigned to me", "rejected snags") directly below
 * this panel — re-rendering attention here would duplicate it. The panel
 * surfaces only the hard `blocked` attention, which the strip does not cover.
 *
 * Actions the model leaves `href`-less are in-page jumps: the model's contract
 * says "the UI maps them to the relevant section on the job page itself", which
 * this panel does via {@link IN_PAGE_ANCHOR}. Cross-surface actions (hours,
 * rejected hours) carry their own `href` and render as real links.
 *
 * Pure + render-friendly: no state, no client mutation — just links and
 * anchors, so it server-renders and unit-tests with `renderToString`.
 *
 * Cross-ref:
 *   src/domains/phil/job-command-model.ts — the model + ranking
 *   src/domains/phil/job-command-input.ts — the real-data bridge
 *   docs/phil-job-command-model.md — intended UI integration
 */

/** In-page anchor targets for actions the model leaves href-less. Keyed by
 *  action id — presentational routing, not data inspection. The targets are
 *  the section ids rendered by PhilJobDetail. */
const IN_PAGE_ANCHOR: Partial<Record<PhilJobActionId, string>> = {
  capture: "#phil-job-capture",
  complete_checks: "#phil-job-itps",
  continue_tasks: "#phil-job-work",
  view_plans: "#phil-job-plans",
  view_tags: "#phil-job-tags",
  report_issue: "#phil-job-snags",
};

const ACTION_ICON: Record<PhilJobActionId, typeof Camera> = {
  fix_rejected_hours: AlertTriangle,
  complete_checks: ClipboardCheck,
  continue_tasks: ListChecks,
  capture: Camera,
  log_hours: Clock,
  view_plans: MapIcon,
  view_tags: ShieldCheck,
  report_issue: AlertOctagon,
};

/** A cross-surface route (href) or an in-page anchor, or null when neither
 *  exists (then the row renders inert rather than as a dead link). */
function actionTarget(action: PhilJobCommandAction): string | null {
  return action.href ?? IN_PAGE_ANCHOR[action.id] ?? null;
}

export function PhilJobCommandPanel({ model }: { model: PhilJobCommandModel }) {
  // The job page resolves load failures (not found / not assigned / error)
  // before rendering, so these states aren't normally reached here — but handle
  // them honestly for safety and so the panel is testable in isolation.
  if (model.state === "error" || model.state === "office_only") {
    const item = model.attention[0];
    if (!item) return null;
    return (
      <PhilNotice tone="warning" title={item.label} role="alert">
        {item.reason ? <p>{item.reason}</p> : null}
      </PhilNotice>
    );
  }

  const blocked = model.attention.filter((a) => a.severity === "blocked");
  const hasContent =
    model.primaryAction !== null ||
    model.actions.length > 0 ||
    blocked.length > 0 ||
    model.limitations.length > 0;
  if (!hasContent) return null;

  return (
    <Card aria-labelledby="phil-job-next-h">
      <CardTitle>
        <span id="phil-job-next-h">Quick actions</span>
      </CardTitle>

      {blocked.length > 0 ? (
        <div className="mt-3 space-y-2">
          {blocked.map((b) => (
            <PhilNotice key={b.id} tone="warning" title={b.label} role="alert">
              {b.reason ? <p>{b.reason}</p> : null}
            </PhilNotice>
          ))}
        </div>
      ) : null}

      {model.primaryAction ? (
        <div className="mt-3">
          <CommandAction action={model.primaryAction} variant="primary" />
        </div>
      ) : model.state === "empty" && blocked.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          Nothing flagged to do on this job right now.
        </p>
      ) : null}

      {model.actions.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {model.actions.map((a) => (
            <li key={a.id}>
              <CommandAction action={a} variant="secondary" />
            </li>
          ))}
        </ul>
      ) : null}

      {model.limitations.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-border pt-3">
          {model.limitations.map((l) => (
            <li key={l.id} className="text-xs text-text-muted">
              <span className="font-medium text-text">{l.label}.</span>
              {l.reason ? ` ${l.reason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function CommandAction({
  action,
  variant,
}: {
  action: PhilJobCommandAction;
  variant: "primary" | "secondary";
}) {
  const target = actionTarget(action);
  const Icon = ACTION_ICON[action.id];
  const isPrimary = variant === "primary";

  const body: ReactNode = (
    <>
      <Icon
        aria-hidden="true"
        className={cn(
          "shrink-0",
          isPrimary ? "h-5 w-5" : "h-4 w-4 text-text-muted",
        )}
      />
      <span className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            "block font-display",
            isPrimary ? "text-base font-semibold" : "text-sm font-medium text-text",
          )}
        >
          {action.label}
        </span>
        {action.reason ? (
          <span
            className={cn(
              "block",
              isPrimary ? "text-xs text-text-inverse/80" : "text-xs text-text-muted",
            )}
          >
            {action.reason}
          </span>
        ) : null}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "shrink-0",
          isPrimary ? "h-5 w-5 text-accent-yellow" : "h-4 w-4 text-text-muted/60",
        )}
      />
    </>
  );

  // Navy-filled primary (yellow stays reserved for the single Capture CTA per
  // screen, per PhilActionButton's doctrine); bordered surface for secondaries.
  const className = cn(
    "flex w-full items-center gap-3 rounded-card transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy",
    isPrimary
      ? "min-h-[56px] bg-brand-navy px-4 py-3 text-text-inverse hover:brightness-110 active:scale-[0.99]"
      : "min-h-[44px] border border-border bg-surface px-3 py-2 hover:bg-surface-subtle",
  );

  if (!target) {
    return <div className={className}>{body}</div>;
  }
  if (target.startsWith("#")) {
    return (
      <a href={target} className={className}>
        {body}
      </a>
    );
  }
  return (
    <Link href={target as Route} className={className}>
      {body}
    </Link>
  );
}
