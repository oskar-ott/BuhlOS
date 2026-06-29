"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
import { archiveGearAsset, markGearGood, reportGear, setGearCalibrationDue, transferGear } from "@/domains/gear/client";
import { AssetEditorSheet } from "@/components/admin/AssetEditorSheet";
import { isLeadingHandRole } from "@/lib/auth/roles";
import { deriveStatus, statusTone } from "@/domains/gear/service";
import {
  assetDisplayName,
  calibrationFlag,
  conditionLabel,
  formatShortDate,
  formatTimestamp,
  historyKindLabel,
  isOverdue,
  statusLabel,
  typeLabel,
} from "@/domains/gear/format";
import type {
  GearAsset,
  GearAssetStatus,
  GearHolderUser,
} from "@/domains/gear/types";
import { listGear, getGearDetail } from "@/domains/gear/client";
import type {
  GearHistoryEntry,
} from "@/domains/gear/types";

interface Props {
  initialAssets: ReadonlyArray<GearAsset>;
  holders: ReadonlyArray<GearHolderUser>;
}

type StatusFilter = "all" | GearAssetStatus;

export function GearRegisterClient({ initialAssets, holders }: Props) {
  const router = useRouter();
  const [assets, setAssets] = useState<ReadonlyArray<GearAsset>>(initialAssets);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [drawerAssetId, setDrawerAssetId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  const visible = useMemo(() => {
    const lower = search.trim().toLowerCase();
    return assets
      .filter((a) => {
        if (filter !== "all" && deriveStatus(a) !== filter) return false;
        if (!lower) return true;
        const blob = [a.name, a.identifier ?? "", a.currentHolderName ?? "", typeLabel(a.type)]
          .join(" ")
          .toLowerCase();
        return blob.includes(lower);
      })
      .slice()
      .sort((a, b) => {
        const aOverdue = isOverdue(a, today);
        const bOverdue = isOverdue(b, today);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [assets, search, filter, today]);

  const counts = useMemo(() => {
    return {
      all: assets.length,
      available: assets.filter((a) => deriveStatus(a) === "available").length,
      assigned: assets.filter((a) => deriveStatus(a) === "assigned").length,
      damaged: assets.filter((a) => deriveStatus(a) === "damaged").length,
      missing: assets.filter((a) => deriveStatus(a) === "missing").length,
      retired: assets.filter((a) => deriveStatus(a) === "retired").length,
    };
  }, [assets]);

  async function refresh() {
    const result = await listGear({ includeArchived: true });
    if (result.ok) setAssets(result.data.assets);
  }

  function handleMutation(promise: Promise<{ ok: boolean; error?: { message: string } }>) {
    setErrorMessage(null);
    startTransition(async () => {
      const result = await promise;
      if (!result.ok) {
        setErrorMessage(result.error?.message ?? "Action failed");
        return;
      }
      await refresh();
      router.refresh();
    });
  }

  const drawerAsset = drawerAssetId ? assets.find((a) => a.id === drawerAssetId) ?? null : null;
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; asset: GearAsset } | null
  >(null);
  const [archiveTarget, setArchiveTarget] = useState<GearAsset | null>(null);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex-1 min-w-[200px]">
            <span className="sr-only">Search assets</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, identifier, or holder…"
              className="h-10 w-full rounded-card border border-border bg-surface px-3 text-sm"
            />
          </label>
          <FilterTab label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterTab label="Available" count={counts.available} active={filter === "available"} onClick={() => setFilter("available")} tone="success" />
          <FilterTab label="Assigned" count={counts.assigned} active={filter === "assigned"} onClick={() => setFilter("assigned")} tone="info" />
          <FilterTab label="Damaged" count={counts.damaged} active={filter === "damaged"} onClick={() => setFilter("damaged")} tone="danger" />
          <FilterTab label="Missing" count={counts.missing} active={filter === "missing"} onClick={() => setFilter("missing")} tone="warning" />
          <FilterTab label="Retired" count={counts.retired} active={filter === "retired"} onClick={() => setFilter("retired")} tone="neutral" />
          <Button size="sm" onClick={() => setEditor({ mode: "create" })} data-testid="asset-editor-open">
            Add an asset
          </Button>
        </div>

        {errorMessage ? (
          <p
            role="alert"
            className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          >
            {errorMessage}
          </p>
        ) : null}
      </Card>

      <Card className="p-0 overflow-hidden">
        {/* Mobile (<sm): card list — no horizontal scroll, Manage stays reachable. */}
        <ul className="divide-y divide-border sm:hidden">
          {visible.length === 0 ? (
            <li className="px-4 py-6 text-center text-text-muted">No assets match the current filter.</li>
          ) : (
            visible.map((asset) => {
              const status = deriveStatus(asset);
              const overdue = isOverdue(asset, today);
              const cal = calibrationFlag(asset, today);
              const action = rowAction(asset, today);
              return (
                <li key={asset.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-text" title={asset.name}>{asset.name}</div>
                      {asset.identifier ? (
                        <div className="truncate text-xs text-text-muted">{asset.identifier}</div>
                      ) : null}
                      {asset.notes ? (
                        <div className="truncate text-xs italic text-text-muted" title={asset.notes}>{asset.notes}</div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
                      {overdue ? <Pill tone="danger">Overdue</Pill> : null}
                      {cal ? (
                        <Pill tone={cal.status === "expired" ? "danger" : "warning"}>
                          {cal.status === "expired" ? "Calibration due" : "Calibration soon"}
                        </Pill>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {typeLabel(asset.type)} · {asset.currentHolderName ?? "— depot —"} · {formatTimestamp(asset.assignedAt) ?? "—"}
                  </div>
                  <div className="mt-2 flex gap-2">
                    {action ? (
                      <Button
                        size="sm"
                        variant={action.tone === "danger" ? "danger" : "secondary"}
                        className="flex-1"
                        data-testid={`gear-row-action-${asset.id}`}
                        onClick={() => setDrawerAssetId(asset.id)}
                      >
                        {action.label}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" className="flex-1" onClick={() => setDrawerAssetId(asset.id)}>
                      Manage
                    </Button>
                  </div>
                </li>
              );
            })
          )}
        </ul>
        {/* Desktop / tablet (sm+): the full column table (contained scroll). */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-left text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-4 py-3">Asset</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Current holder</th>
                <th className="px-4 py-3">Since</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                    No assets match the current filter.
                  </td>
                </tr>
              ) : (
                visible.map((asset) => {
                  const status = deriveStatus(asset);
                  const overdue = isOverdue(asset, today);
                  const cal = calibrationFlag(asset, today);
                  const action = rowAction(asset, today);
                  return (
                    <tr key={asset.id} className="hover:bg-surface-subtle">
                      <td className="max-w-xs px-4 py-3">
                        <div className="truncate font-medium text-text" title={asset.name}>
                          {asset.name}
                        </div>
                        {asset.identifier ? (
                          <div className="truncate text-xs text-text-muted">{asset.identifier}</div>
                        ) : null}
                        {asset.notes ? (
                          <div className="truncate text-xs italic text-text-muted" title={asset.notes}>
                            {asset.notes}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-text-muted">{typeLabel(asset.type)}</td>
                      <td className="px-4 py-3">
                        <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
                        {overdue ? (
                          <Pill tone="danger" className="ml-1">
                            Overdue
                          </Pill>
                        ) : null}
                        {cal ? (
                          <Pill tone={cal.status === "expired" ? "danger" : "warning"} className="ml-1">
                            {cal.status === "expired" ? "Calibration due" : "Calibration soon"}
                          </Pill>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {asset.currentHolderName ? (
                          <span className="text-text">{asset.currentHolderName}</span>
                        ) : (
                          <span className="text-text-muted">— depot —</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        {formatTimestamp(asset.assignedAt) ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {action ? (
                            <Button
                              size="sm"
                              variant={action.tone === "danger" ? "danger" : "secondary"}
                              data-testid={`gear-row-action-${asset.id}`}
                              onClick={() => setDrawerAssetId(asset.id)}
                            >
                              {action.label}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setDrawerAssetId(asset.id)}
                          >
                            Manage
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {archiveTarget ? (
        <Modal open onClose={() => setArchiveTarget(null)} title={`Archive ${archiveTarget.name}?`} className="max-w-md">
          <div className="space-y-4 text-sm">
            <p className="text-text-muted">
              It moves to Retired — the record and its history are kept, and it disappears from
              assignment flows.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setArchiveTarget(null)} disabled={isPending}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={isPending}
                data-testid="asset-archive-confirm"
                onClick={() => {
                  const target = archiveTarget;
                  setArchiveTarget(null);
                  setDrawerAssetId(null);
                  if (target) handleMutation(archiveGearAsset(target.id));
                }}
              >
                Archive
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {editor ? (
        <AssetEditorSheet
          mode={editor.mode}
          asset={editor.mode === "edit" ? editor.asset : undefined}
          holders={holders}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            handleMutation(Promise.resolve({ ok: true }));
          }}
        />
      ) : null}

      {drawerAsset ? (
        <AssetDrawer
          asset={drawerAsset}
          holders={holders}
          onClose={() => setDrawerAssetId(null)}
          onMutate={handleMutation}
          onEdit={() => setEditor({ mode: "edit", asset: drawerAsset })}
          onArchive={() => setArchiveTarget(drawerAsset)}
          isPending={isPending}
        />
      ) : null}
    </>
  );
}

/**
 * The status-contextual inline row action (§7 resources redesign). Driven by
 * the existing `deriveStatus` + `calibrationFlag` — NOT a new state:
 *   - overdue calibration  → "Book test"  (jumps to the Calibration section)
 *   - damaged              → "Mark good"   (the repair quick-action)
 *   - missing             → "Mark found"
 * Anything else returns null and only the "Manage" fallback shows. The action
 * opens the asset drawer (where the actual mutation + audit live) — the same
 * place "Manage" goes, so there's one write path, not a duplicated mutation.
 *
 * `today` is the ISO day the page computed once; passing it keeps the
 * calibration flag deterministic with the rest of the table.
 */
function rowAction(
  asset: GearAsset,
  today: string,
): { label: string; tone: "danger" | "warning" } | null {
  const status = deriveStatus(asset);
  if (status === "damaged") return { label: "Mark good", tone: "danger" };
  if (status === "missing") return { label: "Mark found", tone: "warning" };
  if (status === "retired") return null;
  // Test instrument whose calibration has lapsed — book it in.
  const cal = calibrationFlag(asset, today);
  if (cal?.status === "expired") return { label: "Book test", tone: "danger" };
  return null;
}

function FilterTab({
  label,
  count,
  active,
  onClick,
  tone = "neutral",
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: "neutral" | "success" | "info" | "danger" | "warning";
}) {
  const toneClass: Record<typeof tone, string> = {
    neutral: "border-border",
    success: "border-emerald-200",
    info: "border-sky-200",
    danger: "border-rose-200",
    warning: "border-amber-200",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-xs font-medium " +
        toneClass[tone] +
        (active ? " bg-brand-navy text-text-inverse border-brand-navy" : " text-text")
      }
    >
      {label}
      <span className="rounded-pill bg-white/20 px-1.5 text-[10px]">{count}</span>
    </button>
  );
}

interface AssetDrawerProps {
  asset: GearAsset;
  holders: ReadonlyArray<GearHolderUser>;
  onClose: () => void;
  /** Opens the metadata editor for this asset (#389). */
  onEdit: () => void;
  /** Asks the parent to confirm archiving this asset (#389). */
  onArchive: () => void;
  onMutate: (promise: Promise<{ ok: boolean; error?: { message: string } }>) => void;
  isPending: boolean;
}

// Exported for the holder-picker render test: it renders the transfer <select>
// of eligible holders (field-tier + leading hands) and the per-asset actions.
export function AssetDrawer({ asset, holders, onClose, onEdit, onArchive, onMutate, isPending }: AssetDrawerProps) {
  const [history, setHistory] = useState<ReadonlyArray<GearHistoryEntry> | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [toUserId, setToUserId] = useState<string>(asset.currentHolderId ?? "");
  const [note, setNote] = useState("");
  const [calibrationDue, setCalibrationDue] = useState<string>(asset.calibrationDue ?? "");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getGearDetail(asset.id);
      if (cancelled) return;
      if (result.ok) {
        setHistory(result.data.history);
      } else {
        setHistoryError(result.error.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.updatedAt]);

  const status = deriveStatus(asset);
  const eligibleHolders = holders.filter((h) => h.id !== asset.currentHolderId);

  return (
    <Modal open onClose={onClose} title={assetDisplayName(asset)} className="max-w-2xl">
      <div className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
          <dt className="text-text-muted">Status</dt>
          <dd>
            <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
          </dd>
          <dt className="text-text-muted">Type</dt>
          <dd>{typeLabel(asset.type)}</dd>
          <dt className="text-text-muted">Condition</dt>
          <dd>{conditionLabel(asset.condition)}</dd>
          <dt className="text-text-muted">Current holder</dt>
          <dd>{asset.currentHolderName ?? "— depot —"}</dd>
          <dt className="text-text-muted">Assigned since</dt>
          <dd>{formatTimestamp(asset.assignedAt) ?? "—"}</dd>
          <dt className="text-text-muted">Expected return</dt>
          <dd>{formatShortDate(asset.expectedReturn) ?? "open-ended"}</dd>
          {asset.notes ? (
            <>
              <dt className="text-text-muted">Notes</dt>
              <dd>{asset.notes}</dd>
            </>
          ) : null}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit} disabled={isPending} data-testid="asset-drawer-edit">
            Edit details
          </Button>
          {!asset.archived ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending}
              onClick={onArchive}
              data-testid="asset-drawer-archive"
            >
              Archive
            </Button>
          ) : null}
        </div>

        {asset.archived ? null : (
          <section aria-label="Calibration">
            <h3 className="font-display text-sm uppercase tracking-wider text-text-muted">
              Calibration
            </h3>
            <p className="mt-1 text-xs text-text-muted">
              Test instruments only — a due date here feeds the daily compliance alerts, the
              board above and the holder&rsquo;s Phil gear flag. Leave empty otherwise.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={calibrationDue}
                onChange={(e) => setCalibrationDue(e.target.value)}
                className="h-10 rounded-card border border-border bg-surface px-3 text-sm"
                aria-label="Calibration due date"
              />
              <Button
                size="sm"
                disabled={isPending || calibrationDue === (asset.calibrationDue ?? "")}
                onClick={() => onMutate(setGearCalibrationDue(asset.id, calibrationDue || null))}
              >
                Save
              </Button>
              {asset.calibrationDue ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => {
                    setCalibrationDue("");
                    onMutate(setGearCalibrationDue(asset.id, null));
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </section>
        )}

        {asset.archived ? null : (
          <section aria-label="Transfer or return">
            <h3 className="font-display text-sm uppercase tracking-wider text-text-muted">
              Transfer
            </h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr,auto]">
              <select
                value={toUserId}
                onChange={(e) => setToUserId(e.target.value)}
                className="h-10 rounded-card border border-border bg-surface px-3 text-sm"
                aria-label="Transfer to"
              >
                <option value="">— Return to depot —</option>
                {eligibleHolders.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.username}
                    {isLeadingHandRole(h.role) ? " (LH)" : ""}
                  </option>
                ))}
              </select>
              <Button
                disabled={isPending || toUserId === (asset.currentHolderId ?? "")}
                onClick={() =>
                  onMutate(
                    transferGear({
                      assetId: asset.id,
                      toUserId: toUserId || null,
                      note: note.trim() || null,
                    })
                  )
                }
              >
                {toUserId ? "Assign" : "Return"}
              </Button>
            </div>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (visible in history)…"
              className="mt-2 h-10 w-full rounded-card border border-border bg-surface px-3 text-sm"
            />
          </section>
        )}

        {!asset.archived && (asset.currentHolderId || asset.condition === "damaged" || asset.condition === "missing") ? (
          <section aria-label="Mark condition">
            <h3 className="font-display text-sm uppercase tracking-wider text-text-muted">
              Mark condition
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {asset.condition === "damaged" || asset.condition === "missing" ? (
                <Button
                  size="sm"
                  disabled={isPending}
                  onClick={() => onMutate(markGearGood({ assetId: asset.id, note: null }))}
                >
                  Mark good
                </Button>
              ) : null}
              {asset.currentHolderId ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isPending}
                    onClick={() => onMutate(reportGear({ assetId: asset.id, kind: "check" }))}
                  >
                    Confirm checked
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isPending || asset.condition === "damaged"}
                    onClick={() => onMutate(reportGear({ assetId: asset.id, kind: "damaged" }))}
                  >
                    Mark damaged
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isPending || asset.condition === "missing"}
                    onClick={() => onMutate(reportGear({ assetId: asset.id, kind: "missing" }))}
                  >
                    Mark missing
                  </Button>
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        <section aria-label="History">
          <h3 className="font-display text-sm uppercase tracking-wider text-text-muted">
            History
          </h3>
          {historyError ? (
            <p className="mt-2 text-rose-900">Couldn&rsquo;t load history: {historyError}</p>
          ) : history === null ? (
            <p className="mt-2 text-text-muted">Loading history…</p>
          ) : history.length === 0 ? (
            <p className="mt-2 text-text-muted">No history yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {history.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-card border border-border bg-surface-subtle p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text">{historyKindLabel(entry.kind)}</span>
                    <span className="text-text-muted">{formatTimestamp(entry.at) ?? "—"}</span>
                  </div>
                  <div className="mt-1 text-text-muted">
                    {entry.kind === "transfer" || entry.kind === undefined ? (
                      <>
                        {entry.fromName || "Depot"} → {entry.toName || "Depot"}
                      </>
                    ) : entry.kind === "check" ? (
                      <>Confirmed by {entry.byName ?? "—"}</>
                    ) : entry.kind === "report_damaged" ? (
                      <>Damage report by {entry.byName ?? "—"}</>
                    ) : entry.kind === "report_missing" ? (
                      <>Missing report by {entry.byName ?? "—"}</>
                    ) : (
                      <>By {entry.byName ?? "—"}</>
                    )}
                  </div>
                  {entry.note ? (
                    <div className="mt-1 italic text-text-muted">&ldquo;{entry.note}&rdquo;</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
