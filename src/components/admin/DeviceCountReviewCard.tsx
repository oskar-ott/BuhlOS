"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, MapPin, Pencil, Plus, RotateCcw, Square, Trash2, X } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  normToPixel,
  pixelToNorm,
  type NormPoint,
  type PageView,
} from "@/domains/plans/coords";
import type {
  CountReviewPage,
  CropRegion,
  DeviceDetection,
  EffectiveMarker,
  LegendEntry,
  Room,
} from "@/domains/ai-drawings/schema";
import {
  acceptCount,
  addMarker,
  addRoom,
  assignDeviceRoom,
  clearDeviceRoom,
  reviewMarker,
  reviewRoom,
} from "@/domains/ai-drawings/client";

/**
 * Epic 5 (#205) — the count verify loop: markers on the sheet, corrections
 * in place, one sign-off per symbol type.
 *
 * A bare number ("47 GPOs") can only be recounted or trusted blindly — so
 * every count here is backed by tappable markers at the detected locations.
 * Delete a false positive, add a miss, reclassify a wrong type; the count
 * updates live and every action lands append-only in the review trail. The
 * ACCEPTED count (with acceptor + timestamp + the exact marker snapshot) is
 * the only number takeoff assembly ever sees; anything unaccepted — or
 * corrected/re-rendered after acceptance — stays visibly unverified (P7).
 *
 * The overlay reuses the Plan-Viewer idiom: SVG geometry via ATTRIBUTES over
 * the raster (never the lint-banned style prop), pointer-events-none root
 * with per-marker opt-in, and a transparent capture rect in add-mode mapping
 * taps to normalised page coordinates (coords.ts, zoom 1 / rotation 0).
 */

interface CountLookup {
  pngUrlFor: (planId: string, pageIndex: number) => string | null;
  labelFor: (planId: string) => string;
}

// Stable per-entry marker colours (cycled in count order).
const MARKER_TONES = [
  "text-brand-navy",
  "text-rose-600",
  "text-emerald-600",
  "text-amber-500",
  "text-violet-600",
  "text-cyan-600",
  "text-slate-500",
];

// A human-added marker's footprint on the page (normalised) — small, centred
// on the tap, clamped inside the page.
const ADDED_MARKER_SIZE = 0.016;

export function DeviceCountReviewCard({
  jobId,
  pages,
  vocabulary,
  lookup,
  onPage,
}: {
  jobId: string;
  pages: CountReviewPage[];
  vocabulary: LegendEntry[];
  lookup: CountLookup;
  onPage: (page: CountReviewPage) => void;
}) {
  const sorted = useMemo(
    () =>
      [...pages].sort(
        (a, b) => a.planId.localeCompare(b.planId) || a.pageIndex - b.pageIndex,
      ),
    [pages],
  );
  return (
    <section
      aria-label="Device counts (verify and accept)"
      className="rounded-card border border-border bg-surface"
      data-testid="count-review"
    >
      <div className="border-b border-border px-4 py-3">
        <CardTitle>Device counts — verify on the sheet</CardTitle>
        <CardDescription className="mt-1">
          Every count is backed by markers you can check in place: delete a
          false positive, add a miss, reclassify, then accept. Only accepted
          counts reach the takeoff; everything else stays{" "}
          <strong>unverified</strong>.
        </CardDescription>
      </div>
      <div className="divide-y divide-border">
        {sorted.map((page) => (
          <PageReview
            key={`${page.planId}:${page.pageIndex}`}
            jobId={jobId}
            page={page}
            vocabulary={vocabulary}
            lookup={lookup}
            onPage={onPage}
          />
        ))}
      </div>
    </section>
  );
}

function PageReview({
  jobId,
  page,
  vocabulary,
  lookup,
  onPage,
}: {
  jobId: string;
  page: CountReviewPage;
  vocabulary: LegendEntry[];
  lookup: CountLookup;
  onPage: (page: CountReviewPage) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addEntryId, setAddEntryId] = useState<string | null>(null);
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null);
  // #206: two-tap rectangle drawing — redraw an existing room or add one.
  const [drawMode, setDrawMode] = useState<
    { kind: "redraw"; roomId: string } | { kind: "add"; name: string } | null
  >(null);
  const [pendingCorner, setPendingCorner] = useState<NormPoint | null>(null);
  const [newRoomName, setNewRoomName] = useState("");

  const pngUrl = lookup.pngUrlFor(page.planId, page.pageIndex);
  const toneOf = useMemo(() => {
    const ids = page.counts
      .map((c) => c.legendEntryId)
      .filter((id): id is string => Boolean(id));
    const m = new Map<string, string>();
    ids.forEach((id, i) => m.set(id, MARKER_TONES[i % MARKER_TONES.length]!));
    return (id: string | null) => (id ? (m.get(id) ?? MARKER_TONES[0]!) : MARKER_TONES[0]!);
  }, [page.counts]);

  const selected = selectedKey
    ? (page.markers.find((m) => m.key === selectedKey) ?? null)
    : null;

  const run = useCallback(
    async (fn: () => Promise<{ page: CountReviewPage }>) => {
      setBusy(true);
      setNotice("");
      try {
        const out = await fn();
        onPage(out.page);
        return out;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "action failed");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onPage],
  );

  const targetOf = (m: EffectiveMarker) =>
    m.source === "ai" ? { detectionId: m.detectionId! } : { reviewId: m.reviewId! };

  const onDelete = async (m: EffectiveMarker) => {
    const out = await run(() => reviewMarker(jobId, { action: "delete", ...targetOf(m) }));
    if (out) setSelectedKey(null);
  };
  const onRestore = async (m: EffectiveMarker) => {
    const out = await run(() => reviewMarker(jobId, { action: "restore", ...targetOf(m) }));
    if (out) setSelectedKey(null);
  };
  const onReclassify = async (m: EffectiveMarker, toLegendEntryId: string) => {
    const out = await run(() =>
      reviewMarker(jobId, { action: "reclassify", toLegendEntryId, ...targetOf(m) }),
    );
    if (out) setSelectedKey(null);
  };
  const onAddTap = async (p: NormPoint) => {
    if (!addEntryId || busy) return;
    const w = ADDED_MARKER_SIZE;
    const bbox: CropRegion = {
      x: Math.min(Math.max(p.nx - w / 2, 0), 1 - w),
      y: Math.min(Math.max(p.ny - w / 2, 0), 1 - w),
      w,
      h: w,
    };
    await run(() => addMarker(jobId, page.planId, page.pageIndex, bbox, addEntryId));
    // stay in add mode — misses usually come in batches; Done exits.
  };
  const onAccept = async (legendEntryId: string) => {
    await run(() => acceptCount(jobId, page.planId, page.pageIndex, legendEntryId));
  };

  // ── #206: rooms ──
  const liveRooms = useMemo(
    () => page.rooms.filter((r) => r.status !== "rejected"),
    [page.rooms],
  );
  const roomNameOf = useMemo(() => {
    const m = new Map(liveRooms.map((r) => [r.id, r.effectiveName]));
    return (id: string | null) => (id ? (m.get(id) ?? "?") : null);
  }, [liveRooms]);

  const onRoomAction = async (
    roomId: string,
    status: "accepted" | "edited" | "rejected",
    opts: { name?: string; bbox?: CropRegion } = {},
  ) => {
    await run(() => reviewRoom(jobId, roomId, status, opts));
  };
  const onDrawTap = async (p: NormPoint) => {
    if (!drawMode || busy) return;
    if (!pendingCorner) {
      setPendingCorner(p);
      return;
    }
    const first = pendingCorner;
    setPendingCorner(null);
    const mode = drawMode;
    setDrawMode(null);
    const x = Math.min(first.nx, p.nx);
    const y = Math.min(first.ny, p.ny);
    const bbox: CropRegion = {
      x,
      y,
      w: Math.max(Math.abs(p.nx - first.nx), 0.02),
      h: Math.max(Math.abs(p.ny - first.ny), 0.02),
    };
    if (mode.kind === "redraw") {
      await run(() => reviewRoom(jobId, mode.roomId, "edited", { bbox }));
    } else {
      await run(() => addRoom(jobId, page.planId, page.pageIndex, mode.name, bbox));
    }
  };
  const onPinRoom = async (m: EffectiveMarker, value: string) => {
    if (value === "__auto") {
      if (m.roomPinned) {
        await run(() => clearDeviceRoom(jobId, page.planId, page.pageIndex, m.key));
      }
      return;
    }
    const roomId = value === "__unzoned" ? null : value;
    await run(() => assignDeviceRoom(jobId, page.planId, page.pageIndex, m.key, roomId));
  };

  const allVerified =
    page.counts.length > 0 && page.counts.every((c) => c.accepted && !c.accepted.stale);
  const addEntry = addEntryId ? vocabulary.find((v) => v.id === addEntryId) : null;

  return (
    <div className="px-4 py-3" data-testid="count-page">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-semibold text-text">
          {lookup.labelFor(page.planId)} · p{page.pageIndex + 1}
        </span>
        {allVerified ? (
          <Pill tone="success">
            <Check aria-hidden="true" className="mr-1 inline h-3 w-3" />
            counts verified
          </Pill>
        ) : (
          <Pill tone="warning">unverified</Pill>
        )}
        {page.uncertain.length > 0 ? (
          <Pill tone="neutral">
            {page.uncertain.length} area{page.uncertain.length === 1 ? "" : "s"} need a hand
            count
          </Pill>
        ) : null}
      </div>

      {pngUrl ? (
        <div className="mt-2">
          <MarkerOverlay
            pngUrl={pngUrl}
            pageLabel={`${lookup.labelFor(page.planId)} page ${page.pageIndex + 1}`}
            markers={page.markers}
            uncertain={page.uncertain}
            rooms={liveRooms}
            toneOf={toneOf}
            selectedKey={selectedKey}
            focusEntryId={focusEntryId}
            addMode={Boolean(addEntryId)}
            drawMode={Boolean(drawMode)}
            pendingCorner={pendingCorner}
            onMarkerTap={(key) => {
              setAddEntryId(null);
              setDrawMode(null);
              setPendingCorner(null);
              setSelectedKey((k) => (k === key ? null : key));
            }}
            onAddTap={(p) => void onAddTap(p)}
            onDrawTap={(p) => void onDrawTap(p)}
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-text-muted">
          (document no longer on this job — markers can&rsquo;t be shown)
        </p>
      )}

      {addEntry ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-2 text-xs text-text"
          role="status"
        >
          <MapPin aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
          Tap the sheet where the missed <strong>{addEntry.effectiveLabel}</strong> is —
          each tap adds one marker.
          <button
            type="button"
            onClick={() => setAddEntryId(null)}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium hover:bg-surface-subtle"
          >
            <Check aria-hidden="true" className="h-3 w-3" />
            Done adding
          </button>
        </div>
      ) : null}

      {drawMode ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-2 text-xs text-text"
          role="status"
        >
          <Square aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
          {drawMode.kind === "add" ? (
            <>
              Drawing <strong>{drawMode.name}</strong> — tap two opposite corners of the
              room.
            </>
          ) : (
            <>
              Redrawing <strong>{roomNameOf(drawMode.roomId)}</strong> — tap two opposite
              corners of the new box.
            </>
          )}
          {pendingCorner ? " First corner set." : ""}
          <button
            type="button"
            onClick={() => {
              setDrawMode(null);
              setPendingCorner(null);
            }}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-3 w-3" />
            Cancel
          </button>
        </div>
      ) : null}

      {selected ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs"
          data-testid="marker-actions"
        >
          <span className="text-text">
            {selected.label ?? "device"} marker ·{" "}
            {selected.source === "ai"
              ? `AI${selected.confidence !== null ? ` ${Math.round(selected.confidence * 100)}%` : ""}`
              : "added by review"}
            {selected.status === "deleted" ? " · removed" : ""}
          </span>
          {selected.status === "live" ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDelete(selected)}
                className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
              >
                <Trash2 aria-hidden="true" className="h-3 w-3" />
                Not a {selected.label ?? "device"} (remove)
              </button>
              <label className="inline-flex items-center gap-1 text-text-muted">
                Reclassify to
                <select
                  aria-label="Reclassify marker to another symbol type"
                  disabled={busy}
                  value=""
                  onChange={(e) => {
                    if (e.target.value) void onReclassify(selected, e.target.value);
                  }}
                  className="h-6 rounded-card border border-border bg-surface px-1 text-xs text-text"
                >
                  <option value="">choose…</option>
                  {vocabulary
                    .filter((v) => v.id !== selected.legendEntryId)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.effectiveLabel}
                      </option>
                    ))}
                </select>
              </label>
              {liveRooms.length > 0 ? (
                <label className="inline-flex items-center gap-1 text-text-muted">
                  Room
                  <select
                    aria-label="Assign this marker to a room"
                    disabled={busy}
                    value={
                      selected.roomPinned ? (selected.roomId ?? "__unzoned") : "__auto"
                    }
                    onChange={(e) => void onPinRoom(selected, e.target.value)}
                    className="h-6 rounded-card border border-border bg-surface px-1 text-xs text-text"
                    data-testid="marker-room-select"
                  >
                    <option value="__auto">
                      Auto{!selected.roomPinned ? ` (${roomNameOf(selected.roomId) ?? "unzoned"})` : ""}
                    </option>
                    <option value="__unzoned">Unzoned (pinned)</option>
                    {liveRooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.effectiveName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onRestore(selected)}
              className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" />
              Restore
            </button>
          )}
          <button
            type="button"
            onClick={() => setSelectedKey(null)}
            aria-label="Close marker actions"
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-card border border-border bg-surface text-text-muted hover:text-text"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      <ul className="mt-2 space-y-1.5">
        {page.counts.map((c) => (
          <CountRowView
            key={c.legendEntryId ?? "(unlabelled)"}
            row={c}
            tone={toneOf(c.legendEntryId)}
            busy={busy}
            focused={focusEntryId === c.legendEntryId}
            onFocus={() =>
              setFocusEntryId((id) => (id === c.legendEntryId ? null : c.legendEntryId))
            }
            onAddMissed={
              c.legendEntryId
                ? () => {
                    setSelectedKey(null);
                    setAddEntryId(c.legendEntryId);
                  }
                : undefined
            }
            onAccept={c.legendEntryId ? () => void onAccept(c.legendEntryId!) : undefined}
          />
        ))}
      </ul>
      {page.rooms.length > 0 || page.markers.some((m) => m.status === "live") ? (
        <div className="mt-3" data-testid="rooms-section">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Rooms
            </span>
            {liveRooms.length > 0 ? (
              <span className="text-xs text-text-muted">
                {liveRooms.length} on this sheet (approximate boxes — redraw to correct)
              </span>
            ) : (
              <span className="text-xs text-text-muted">
                none mapped yet — run &ldquo;Map rooms&rdquo; on the sheet or add one
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-1">
              <input
                type="text"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                placeholder="Room name…"
                aria-label="Name for a new room"
                className="h-6 w-28 rounded-card border border-border bg-surface px-2 text-xs text-text"
              />
              <button
                type="button"
                disabled={busy || !newRoomName.trim() || !pngUrl}
                onClick={() => {
                  setAddEntryId(null);
                  setSelectedKey(null);
                  setPendingCorner(null);
                  setDrawMode({ kind: "add", name: newRoomName.trim() });
                  setNewRoomName("");
                }}
                className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
              >
                <Plus aria-hidden="true" className="h-3 w-3" />
                Draw room
              </button>
            </span>
          </div>
          {liveRooms.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {liveRooms.map((r) => (
                <RoomRow
                  key={r.id}
                  room={r}
                  deviceCount={
                    page.byRoom.find((g) => g.roomId === r.id)?.total ?? 0
                  }
                  busy={busy}
                  canDraw={Boolean(pngUrl)}
                  onAccept={() => void onRoomAction(r.id, "accepted")}
                  onRename={(name) => void onRoomAction(r.id, "edited", { name })}
                  onRedraw={() => {
                    setAddEntryId(null);
                    setSelectedKey(null);
                    setPendingCorner(null);
                    setDrawMode({ kind: "redraw", roomId: r.id });
                  }}
                  onReject={() => void onRoomAction(r.id, "rejected")}
                />
              ))}
            </ul>
          ) : null}
          {page.byRoom.length > 0 ? (
            <ul className="mt-2 space-y-1" data-testid="by-room">
              {page.byRoom.map((g) => (
                <li
                  key={g.roomId ?? "(unzoned)"}
                  className={cn(
                    "flex flex-wrap items-baseline gap-2 rounded-card border px-3 py-1.5 text-xs",
                    g.roomId === null
                      ? "border-dashed border-amber-500 text-text"
                      : "border-border text-text",
                  )}
                  data-testid={g.roomId === null ? "by-room-unzoned" : "by-room-row"}
                >
                  <span className="font-medium">
                    {g.roomId === null ? "Unzoned (outside every room)" : g.roomName}
                  </span>
                  <span className="font-semibold">{g.total}</span>
                  <span className="text-text-muted">
                    {g.entries
                      .map((e) => `${e.count}× ${e.label ?? "(unlabelled)"}`)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {page.uncertain.length > 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          The AI flagged {page.uncertain.length} dense area
          {page.uncertain.length === 1 ? "" : "s"} (dashed on the sheet) instead of
          guessing — count those by hand with &ldquo;Add missed&rdquo;.
        </p>
      ) : null}
      {notice ? (
        <p className="mt-2 text-xs text-amber-700" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function CountRowView({
  row,
  tone,
  busy,
  focused,
  onFocus,
  onAddMissed,
  onAccept,
}: {
  row: CountReviewPage["counts"][number];
  tone: string;
  busy: boolean;
  focused: boolean;
  onFocus: () => void;
  onAddMissed?: () => void;
  onAccept?: () => void;
}) {
  const acc = row.accepted;
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-card border border-border px-3 py-1.5"
      data-testid="count-row"
    >
      <button
        type="button"
        onClick={onFocus}
        aria-pressed={focused}
        aria-label={`Highlight ${row.label ?? "unlabelled"} markers on the sheet`}
        className="inline-flex items-center gap-2 text-left"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" className={cn("h-3 w-3", tone)}>
          <circle cx={6} cy={6} r={5} fill="currentColor" />
        </svg>
        <span className={cn("text-sm text-text", focused ? "font-semibold" : "font-medium")}>
          {row.label ?? "(unlabelled)"}
        </span>
      </button>
      <span className="text-sm font-semibold text-text">{row.liveCount}</span>
      <span className="text-xs text-text-muted">
        {row.removedCount > 0 ? `${row.removedCount} removed · ` : ""}
        {row.addedCount > 0 ? `${row.addedCount} added by review · ` : ""}
        {row.liveCount - row.addedCount} from AI
      </span>
      <span className="ml-auto inline-flex flex-wrap items-center gap-2">
        {onAddMissed ? (
          <button
            type="button"
            disabled={busy}
            onClick={onAddMissed}
            className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
          >
            <Plus aria-hidden="true" className="h-3 w-3" />
            Add missed
          </button>
        ) : null}
        {acc && !acc.stale ? (
          <Pill tone="success">
            <Check aria-hidden="true" className="mr-1 inline h-3 w-3" />
            {acc.count} verified · {acc.acceptedBy ?? "?"}
          </Pill>
        ) : (
          <>
            {acc && acc.stale ? (
              <Pill tone="warning">changed since sign-off ({acc.count} accepted)</Pill>
            ) : (
              <Pill tone="warning">unverified</Pill>
            )}
            {onAccept ? (
              <button
                type="button"
                disabled={busy}
                onClick={onAccept}
                data-testid="accept-count"
                className="inline-flex h-6 items-center gap-1 rounded-card border border-brand-navy bg-brand-navy px-2 text-xs font-medium text-text-inverse hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check aria-hidden="true" className="h-3 w-3" />
                Accept {row.liveCount} as verified
              </button>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}

function RoomRow({
  room,
  deviceCount,
  busy,
  canDraw,
  onAccept,
  onRename,
  onRedraw,
  onReject,
}: {
  room: Room;
  deviceCount: number;
  busy: boolean;
  canDraw: boolean;
  onAccept: () => void;
  onRename: (name: string) => void;
  onRedraw: () => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.effectiveName);
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-card border border-border px-3 py-1"
      data-testid="room-row"
    >
      {editing ? (
        <>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Rename room ${room.effectiveName}`}
            className="h-6 w-32 rounded-card border border-border bg-surface px-2 text-xs text-text"
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => {
              setEditing(false);
              if (draft.trim() && draft.trim() !== room.effectiveName) onRename(draft.trim());
            }}
            className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle"
          >
            <Check aria-hidden="true" className="h-3 w-3" />
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(room.effectiveName);
            }}
            aria-label="Cancel rename"
            className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border bg-surface text-text-muted hover:text-text"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </>
      ) : (
        <span className="text-xs font-medium text-text">{room.effectiveName}</span>
      )}
      {room.status === "suggested" ? (
        <Pill tone="warning">AI · {room.confidence !== null ? `${Math.round(room.confidence * 100)}%` : "?"}</Pill>
      ) : (
        <Pill tone="neutral">{room.origin === "human" ? "added" : room.status}</Pill>
      )}
      <span className="text-xs text-text-muted">
        {deviceCount} device{deviceCount === 1 ? "" : "s"}
      </span>
      <span className="ml-auto inline-flex items-center gap-1">
        {room.status === "suggested" ? (
          <button
            type="button"
            disabled={busy}
            onClick={onAccept}
            aria-label={`Accept room ${room.effectiveName}`}
            className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
          >
            <Check aria-hidden="true" className="h-3 w-3" />
            Accept
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing((v) => !v)}
          aria-label={`Rename room ${room.effectiveName}`}
          className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
        >
          <Pencil aria-hidden="true" className="h-3 w-3" />
          Rename
        </button>
        <button
          type="button"
          disabled={busy || !canDraw}
          onClick={onRedraw}
          aria-label={`Redraw room ${room.effectiveName}`}
          className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
        >
          <Square aria-hidden="true" className="h-3 w-3" />
          Redraw
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          aria-label={`Reject room ${room.effectiveName} (not a room)`}
          className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 text-xs font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
        >
          <Trash2 aria-hidden="true" className="h-3 w-3" />
          Not a room
        </button>
      </span>
    </li>
  );
}

function MarkerOverlay({
  pngUrl,
  pageLabel,
  markers,
  uncertain,
  rooms,
  toneOf,
  selectedKey,
  focusEntryId,
  addMode,
  drawMode,
  pendingCorner,
  onMarkerTap,
  onAddTap,
  onDrawTap,
}: {
  pngUrl: string;
  pageLabel: string;
  markers: EffectiveMarker[];
  uncertain: DeviceDetection[];
  rooms: Room[];
  toneOf: (id: string | null) => string;
  selectedKey: string | null;
  focusEntryId: string | null;
  addMode: boolean;
  drawMode: boolean;
  pendingCorner: NormPoint | null;
  onMarkerTap: (key: string) => void;
  onAddTap: (p: NormPoint) => void;
  onDrawTap: (p: NormPoint) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const measure = useCallback(() => {
    const img = imgRef.current;
    if (img && img.clientWidth > 0 && img.clientHeight > 0) {
      setSize({ w: img.clientWidth, h: img.clientHeight });
    }
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    return () => ro.disconnect();
  }, [measure]);

  const view: PageView | null = size
    ? {
        baseWidth: size.w,
        baseHeight: size.h,
        zoom: 1,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
      }
    : null;

  const handleCaptureClick = (e: React.MouseEvent<SVGRectElement>) => {
    if (!view) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = pixelToNorm({ px: e.clientX - rect.left, py: e.clientY - rect.top }, view);
    if (drawMode) onDrawTap(p);
    else onAddTap(p);
  };

  return (
    <div className="relative" data-testid="marker-overlay">
      {/* eslint-disable-next-line @next/next/no-img-element -- blob-hosted page raster; overlay needs its measured box */}
      <img
        ref={imgRef}
        src={pngUrl}
        alt={`${pageLabel} with device markers`}
        onLoad={measure}
        className="w-full rounded-card border border-border"
      />
      {view && size ? (
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
        >
          {addMode || drawMode ? (
            <rect
              x={0}
              y={0}
              width={size.w}
              height={size.h}
              fill="transparent"
              className="pointer-events-auto cursor-crosshair"
              onClick={handleCaptureClick}
              data-testid="marker-add-capture"
            />
          ) : null}
          {rooms.map((r) => {
            const tl = normToPixel({ nx: r.effectiveBbox.x, ny: r.effectiveBbox.y }, view);
            const br = normToPixel(
              { nx: r.effectiveBbox.x + r.effectiveBbox.w, ny: r.effectiveBbox.y + r.effectiveBbox.h },
              view,
            );
            return (
              <g key={r.id} className="pointer-events-none text-slate-500" data-testid="room-rect">
                <rect
                  x={tl.px}
                  y={tl.py}
                  width={br.px - tl.px}
                  height={br.py - tl.py}
                  fill="currentColor"
                  fillOpacity={0.04}
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeDasharray={r.status === "suggested" ? "6 4" : undefined}
                  strokeOpacity={0.7}
                />
                <text
                  x={tl.px + 4}
                  y={tl.py + 12}
                  fontSize={10}
                  fill="currentColor"
                  fillOpacity={0.9}
                  className="select-none"
                >
                  {r.effectiveName}
                </text>
              </g>
            );
          })}
          {pendingCorner ? (
            <circle
              cx={normToPixel(pendingCorner, view).px}
              cy={normToPixel(pendingCorner, view).py}
              r={5}
              fill="currentColor"
              stroke="white"
              strokeWidth={1.5}
              className="text-brand-navy"
            />
          ) : null}
          {uncertain.map((u) => {
            const tl = normToPixel({ nx: u.bbox.x, ny: u.bbox.y }, view);
            const br = normToPixel({ nx: u.bbox.x + u.bbox.w, ny: u.bbox.y + u.bbox.h }, view);
            return (
              <rect
                key={u.id}
                x={tl.px}
                y={tl.py}
                width={br.px - tl.px}
                height={br.py - tl.py}
                fill="currentColor"
                fillOpacity={0.08}
                stroke="currentColor"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                className="text-amber-500"
                data-testid="uncertain-rect"
              />
            );
          })}
          {markers.map((m) => {
            const c = normToPixel(
              { nx: m.bbox.x + m.bbox.w / 2, ny: m.bbox.y + m.bbox.h / 2 },
              view,
            );
            const tone = toneOf(m.legendEntryId);
            const dimmed = focusEntryId !== null && m.legendEntryId !== focusEntryId;
            const isSelected = m.key === selectedKey;
            if (m.status === "deleted") {
              return (
                <circle
                  key={m.key}
                  cx={c.px}
                  cy={c.py}
                  r={6}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                  strokeOpacity={dimmed ? 0.15 : 0.5}
                  className={cn("pointer-events-auto cursor-pointer", tone)}
                  role="button"
                  aria-label={`Removed ${m.label ?? "device"} marker — select to restore`}
                  onClick={() => onMarkerTap(m.key)}
                  data-testid="marker-ghost"
                />
              );
            }
            return (
              <g
                key={m.key}
                className={cn("pointer-events-auto cursor-pointer", tone)}
                role="button"
                aria-label={`${m.label ?? "device"} marker${m.source === "human" ? " (added by review)" : ""} — select to review`}
                onClick={() => onMarkerTap(m.key)}
                data-testid="marker-dot"
              >
                {isSelected ? (
                  <circle cx={c.px} cy={c.py} r={13} fill="currentColor" fillOpacity={0.2} />
                ) : null}
                <circle
                  cx={c.px}
                  cy={c.py}
                  r={7}
                  fill="currentColor"
                  fillOpacity={dimmed ? 0.25 : 0.9}
                  stroke="white"
                  strokeWidth={1.5}
                />
                {m.source === "human" ? (
                  // added-by-review markers carry a small cross so the human
                  // origin is visible right on the sheet
                  <path
                    d={`M ${c.px - 3} ${c.py} H ${c.px + 3} M ${c.px} ${c.py - 3} V ${c.py + 3}`}
                    stroke="white"
                    strokeWidth={1.5}
                    strokeOpacity={dimmed ? 0.4 : 1}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}
