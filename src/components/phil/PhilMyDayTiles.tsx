"use client";

import { AlertTriangle, OctagonAlert, Package, ReceiptText, type LucideIcon } from "lucide-react";
import { officeOptionByKey, workerOptionByKey } from "@/domains/observations/service";
import { useCaptureLauncher } from "./captureLauncherContext";
import type { CaptureQuickAction } from "./philCapture";

interface QuickTile {
  action: CaptureQuickAction;
  Icon: LucideIcon;
}

/**
 * Four day-to-day Capture actions surfaced as tiles on My Day, so a worker
 * reaches them in one tap instead of stepping through the camera-first Capture
 * flow behind the FAB. Each tile opens the SAME launcher (and the same proven
 * submit path) preset to its action — these tiles never submit anything on
 * their own. The set mirrors real Capture options (no invented actions, P7):
 * Blocker / Need material / Issue-defect (worker, job-scoped) and the office
 * "Fine / ticket / paperwork" send.
 */
const TILES: ReadonlyArray<QuickTile> = [
  { action: { kind: "worker", optionKey: "blocker" }, Icon: OctagonAlert },
  { action: { kind: "worker", optionKey: "material_request" }, Icon: Package },
  { action: { kind: "worker", optionKey: "defect" }, Icon: AlertTriangle },
  { action: { kind: "office", optionKey: "paperwork" }, Icon: ReceiptText },
];

/**
 * Label + hint come from the SAME option definition the launcher shows, so a
 * tile and the form it opens speak one dialect (P11) — the wording stays in
 * lockstep with WORKER_CAPTURE_OPTIONS / OFFICE_CAPTURE_OPTIONS, never a second
 * hand-written copy. A key with no matching option drops out (P7 — no dead tile).
 */
function tileText(action: CaptureQuickAction): { label: string; hint: string } | null {
  const option =
    action.kind === "office"
      ? officeOptionByKey(action.optionKey)
      : (workerOptionByKey(action.optionKey) ?? null);
  return option ? { label: option.label, hint: option.hint } : null;
}

export function PhilMyDayTiles() {
  const { openQuickCapture } = useCaptureLauncher();
  const tiles = TILES.map((t) => ({ ...t, text: tileText(t.action) })).filter(
    (t): t is QuickTile & { text: { label: string; hint: string } } => t.text !== null,
  );
  if (tiles.length === 0) return null;

  return (
    <section aria-labelledby="phil-quick-actions">
      <h2
        id="phil-quick-actions"
        className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted"
      >
        Quick actions
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map(({ action, Icon, text }) => (
          <button
            key={`${action.kind}:${action.optionKey}`}
            type="button"
            onClick={() => openQuickCapture(action)}
            className="flex min-h-[84px] flex-col gap-1.5 rounded-card border border-border bg-surface-raised p-3 text-left shadow-card transition-colors active:bg-surface-subtle"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent-yellow text-brand-navy">
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold leading-tight text-text">{text.label}</span>
            <span className="text-xs leading-tight text-text-muted">{text.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
