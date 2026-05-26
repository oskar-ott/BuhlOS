"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { recordItpPoint } from "@/domains/itp/client";
import { isFieldRole, isLeadingHandRole, isAdminRole } from "@/lib/auth/roles";
import {
  ITP_RESULT_NOTE_MAX,
  RecordITPPointPayloadSchema,
} from "@/domains/itp/schema";
import { valuePassFailLabel } from "@/domains/itp/format";
import { resizeImageToDataUrl } from "@/domains/evidence/service";
import type { ITPInstance, ITPTemplatePoint } from "@/domains/itp/types";
import { cn } from "@/lib/cn";

interface Props {
  jobId: string;
  instance: ITPInstance;
  point: ITPTemplatePoint;
  viewer: { id: string; role: string };
  /** Called after a successful save so the parent can apply the
   *  canonical instance returned by the server. */
  onSaved: (next: ITPInstance) => void;
  /** Called on any non-200 so the parent can decide whether to surface
   *  a banner (e.g. on a 409 it should prompt a reload). */
  onError: (message: string, status: number) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "uploading" }
  | { kind: "submitting" }
  | { kind: "saved"; at: string };

const SAVED_FADE_MS = 1500;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const RESIZE_TARGET = 1920;
const RESIZE_QUALITY = 0.7;

/**
 * Phil — single ITP point recorder card (Phase E1b).
 *
 * One card per template point; switches on `point.type`:
 *   photo   → camera/gallery picker + note input
 *   value   → number input + unit hint + pass-criterion hint + note
 *   signoff → "Mark complete" toggle + note (disabled if witnessRole
 *             excludes the viewer)
 *   note    → textarea only
 *
 * Submit-per-card model — auto-saves on tap, not on every keystroke,
 * so the worker isn't fighting the keyboard. Photo points POST the
 * image to /api/photos?action=upload-itp-photo first to get a public
 * URL, then POST /api/job-itps?action=record with the URL + note.
 *
 * Errors are mapped to a short message and surfaced via `onError` so
 * the parent can render one banner above the point list (avoiding
 * "404 mole-whack" inside each card).
 *
 * Cross-ref:
 *   src/domains/itp/client.ts → recordItpPoint
 *   src/domains/evidence/service.ts → resizeImageToDataUrl (lifted for ITP)
 *   src/components/phil/CapturePhotoPicker.tsx — photo-picker precedent
 */
export function ITPPointCard({
  jobId,
  instance,
  point,
  viewer,
  onSaved,
  onError,
}: Props) {
  const existing = instance.results?.[point.id];
  const initialValue = useMemo(() => {
    if (point.type === "value") {
      const v = existing?.value;
      if (typeof v === "number") return String(v);
      if (typeof v === "string") return v;
      return "";
    }
    if (point.type === "signoff") {
      return existing?.value === true ? "yes" : "";
    }
    return "";
  }, [existing, point.type]);

  const [valueInput, setValueInput] = useState(initialValue);
  const [note, setNote] = useState(existing?.note ?? "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(
    existing?.photoUrl ?? null,
  );
  const [phase, setPhase] = useState<Phase>(
    existing?.at ? { kind: "saved", at: existing.at } : { kind: "idle" },
  );

  // Reset internal state when the canonical row from the server
  // updates (parent re-renders us with a new instance prop).
  useEffect(() => {
    if (!existing) return;
    if (point.type === "value") {
      const v = existing.value;
      setValueInput(typeof v === "number" || typeof v === "string" ? String(v) : "");
    } else if (point.type === "signoff") {
      setValueInput(existing.value === true ? "yes" : "");
    }
    setNote(existing.note ?? "");
    setPhotoUrl(existing.photoUrl ?? null);
  }, [existing, point.type]);

  const inputRef = useRef<HTMLInputElement>(null);
  const disabledSignoff =
    point.type === "signoff" && !witnessRoleMatches(point.witnessRole, viewer);

  const handleValueChange = (next: string) => {
    setValueInput(next);
    setPhase({ kind: "dirty" });
  };
  const handleNoteChange = (next: string) => {
    setNote(next.slice(0, ITP_RESULT_NOTE_MAX));
    setPhase({ kind: "dirty" });
  };

  async function handlePickPhoto(file: File) {
    if (!file.type.startsWith("image/")) {
      onError("That isn't an image. Pick a photo or use the camera.", 400);
      return;
    }
    setPhase({ kind: "uploading" });
    try {
      const dataUrl = await resizeImageToDataUrl(
        file,
        RESIZE_TARGET,
        RESIZE_QUALITY,
      );
      const res = await fetch(
        `/api/photos?jobId=${encodeURIComponent(jobId)}&action=upload-itp-photo`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataUrl,
            instanceId: instance.id,
            pointId: point.id,
          }),
        },
      );
      if (!res.ok) {
        if (res.status === 413) {
          onError("Photo too large. Try again.", 413);
        } else if (res.status === 403) {
          onError("You can't record this point.", 403);
        } else {
          const body = await res.json().catch(() => null);
          onError(
            (body && typeof body.error === "string" && body.error) ||
              `Photo upload failed (${res.status}).`,
            res.status,
          );
        }
        setPhase({ kind: "dirty" });
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (!body.url) {
        onError("Photo upload returned no URL.", 0);
        setPhase({ kind: "dirty" });
        return;
      }
      setPhotoUrl(body.url);
      // Photo uploads complete the photo half of the point but we still
      // need to POST /api/job-itps?action=record so the result row is
      // attributed to the worker + auto-advance logic runs.
      await handleSubmit({ photoUrlOverride: body.url });
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Photo upload failed.",
        0,
      );
      setPhase({ kind: "dirty" });
    }
  }

  async function handleSubmit(opts?: { photoUrlOverride?: string }) {
    const payloadBase = { instanceId: instance.id, pointId: point.id };
    const payload: Record<string, unknown> = { ...payloadBase };
    if (point.type === "value") {
      const trimmed = valueInput.trim();
      if (trimmed === "") {
        onError("Enter a value before saving.", 400);
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        onError("Value must be a number.", 400);
        return;
      }
      payload.value = n;
    } else if (point.type === "signoff") {
      payload.value = valueInput === "yes";
    } else if (point.type === "note") {
      if (note.trim() === "") {
        onError("Add a note before saving.", 400);
        return;
      }
    }
    if (note.trim() !== "") payload.note = note.trim();
    const photoOverride = opts?.photoUrlOverride;
    const photoForPost = photoOverride ?? photoUrl;
    if (photoForPost) payload.photoUrl = photoForPost;

    const parsed = RecordITPPointPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      onError(parsed.error.issues[0]?.message ?? "Invalid input.", 400);
      return;
    }

    setPhase({ kind: "submitting" });
    const r = await recordItpPoint(jobId, parsed.data);
    if (r.ok) {
      onSaved(r.data.instance);
      const nowIso = new Date().toISOString();
      setPhase({ kind: "saved", at: nowIso });
      window.setTimeout(() => {
        setPhase((p) =>
          p.kind === "saved" && p.at === nowIso ? { kind: "idle" } : p,
        );
      }, SAVED_FADE_MS);
      return;
    }
    const status = r.error.status;
    const message =
      status === 403
        ? "You can't record this point."
        : status === 409
          ? "This ITP has been updated. Reload to see the latest."
          : status === 400
            ? r.error.message || "Invalid request."
            : r.error.message || "Couldn't save. Try again.";
    onError(message, status);
    setPhase({ kind: "dirty" });
  }

  const required = point.required !== false;
  const passFail =
    point.type === "value" ? valuePassFailLabel(point, existing) : null;
  const labelTitle = point.label || pointTypeFallbackLabel(point.type);
  const pillTone =
    phase.kind === "saved"
      ? "success"
      : phase.kind === "submitting" || phase.kind === "uploading"
        ? "info"
        : null;

  return (
    <section
      className={cn(
        "rounded-card border border-border bg-surface-raised p-4 shadow-card",
      )}
      aria-label={`Point: ${labelTitle}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold text-text">
            {labelTitle}
            {required ? (
              <span aria-label="required" className="ml-1 text-state-danger">
                *
              </span>
            ) : null}
          </h3>
          {pointTypeHint(point) ? (
            <p className="mt-0.5 text-xs text-text-muted">{pointTypeHint(point)}</p>
          ) : null}
        </div>
        {pillTone ? (
          <Pill tone={pillTone} className="shrink-0">
            {phase.kind === "uploading"
              ? "Uploading"
              : phase.kind === "submitting"
                ? "Saving"
                : "Saved"}
          </Pill>
        ) : passFail ? (
          <Pill
            tone={passFail === "Pass" ? "success" : "danger"}
            className="shrink-0"
          >
            {passFail}
          </Pill>
        ) : null}
      </header>

      <div className="mt-3 space-y-3">
        {point.type === "photo" ? (
          <PhotoSection
            inputRef={inputRef}
            photoUrl={photoUrl}
            busy={phase.kind === "uploading" || phase.kind === "submitting"}
            onPick={handlePickPhoto}
          />
        ) : null}

        {point.type === "value" ? (
          <ValueInput
            value={valueInput}
            unit={point.unit ?? null}
            min={point.min ?? null}
            max={point.max ?? null}
            onChange={handleValueChange}
          />
        ) : null}

        {point.type === "signoff" ? (
          <SignoffInput
            value={valueInput === "yes"}
            disabled={disabledSignoff}
            disabledReason={
              disabledSignoff
                ? `Only ${witnessRoleLabel(point.witnessRole)} can mark this complete.`
                : null
            }
            onChange={(checked) => {
              setValueInput(checked ? "yes" : "");
              setPhase({ kind: "dirty" });
            }}
          />
        ) : null}

        <NoteInput value={note} onChange={handleNoteChange} type={point.type} />

        {point.type !== "photo" ? (
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={() => handleSubmit()}
            disabled={
              phase.kind === "submitting" ||
              phase.kind === "uploading" ||
              disabledSignoff
            }
            className="w-full bg-accent-yellow text-brand-navy hover:bg-accent-yellow"
          >
            {phase.kind === "saved" ? (
              <>
                <Check aria-hidden="true" className="h-5 w-5" />
                Update
              </>
            ) : (
              <>Save</>
            )}
          </Button>
        ) : null}

        {existing?.byUsername ? (
          <p className="text-xs text-text-muted">
            Last recorded by {existing.byUsername}
            {existing.at ? ` · ${formatRelativeShort(existing.at)}` : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------
 * Sub-inputs
 * -------------------------------------------------------------------*/

function PhotoSection({
  inputRef,
  photoUrl,
  busy,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  photoUrl: string | null;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  function handleClick() {
    if (busy) return;
    inputRef.current?.click();
  }
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > MAX_PHOTO_BYTES) {
      // Upstream resize should keep us well under the cap, but a guard
      // here protects against pathological raw uploads.
      return;
    }
    onPick(f);
  }
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={handleChange}
        aria-label="Take or choose a photo"
      />
      {photoUrl ? (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-card border border-border bg-surface-subtle">
            {/* eslint-disable-next-line @next/next/no-img-element -- public Blob URL preview */}
            <img
              src={photoUrl}
              alt="Recorded point photo"
              className="block max-h-72 w-full object-contain"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClick}
            disabled={busy}
            className="w-full"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4" />
            Retake
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className={cn(
            "flex w-full min-h-[56px] flex-col items-center justify-center gap-2",
            "rounded-card border-2 border-dashed border-border bg-surface-subtle",
            "px-4 py-6 text-center transition-colors",
            "hover:border-brand-navy hover:bg-surface",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <Camera aria-hidden="true" className="h-7 w-7 text-text-muted" />
          <span className="font-display text-base font-semibold text-text">
            Take a photo
          </span>
          <span className="text-xs text-text-muted">
            Camera opens by default. Choose from gallery if you prefer.
          </span>
        </button>
      )}
    </div>
  );
}

function ValueInput({
  value,
  unit,
  min,
  max,
  onChange,
}: {
  value: string;
  unit: string | null;
  min: number | null;
  max: number | null;
  onChange: (next: string) => void;
}) {
  const passHint = formatPassHint(min, max, unit);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[48px] flex-1 rounded-card border border-border bg-surface px-3 text-base outline-none focus:border-brand-navy focus:ring-2 focus:ring-brand-navy"
          aria-label={unit ? `Value in ${unit}` : "Value"}
        />
        {unit ? (
          <span className="font-display text-sm text-text-muted">{unit}</span>
        ) : null}
      </div>
      {passHint ? (
        <p className="text-xs text-text-muted">{passHint}</p>
      ) : null}
    </div>
  );
}

function SignoffInput({
  value,
  disabled,
  disabledReason,
  onChange,
}: {
  value: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      <label
        className={cn(
          "flex min-h-[48px] cursor-pointer items-center gap-3 rounded-card border border-border bg-surface px-3",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-5 w-5"
          aria-label="Mark this point complete"
        />
        <span className="font-display text-base font-semibold text-text">
          Mark complete
        </span>
      </label>
      {disabledReason ? (
        <p className="text-xs text-text-muted">{disabledReason}</p>
      ) : null}
    </div>
  );
}

function NoteInput({
  value,
  onChange,
  type,
}: {
  value: string;
  onChange: (next: string) => void;
  type: ITPTemplatePoint["type"];
}) {
  const required = type === "note";
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium uppercase tracking-wider text-text-muted">
        Note {required ? null : <span className="text-text-muted/60">(optional)</span>}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={ITP_RESULT_NOTE_MAX}
        className="min-h-[64px] w-full rounded-card border border-border bg-surface p-3 text-sm outline-none focus:border-brand-navy focus:ring-2 focus:ring-brand-navy"
        placeholder={required ? "What did you find?" : "Anything worth flagging?"}
      />
      <p className="text-right text-[10px] text-text-muted/60">
        {value.length} / {ITP_RESULT_NOTE_MAX}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------*/

function pointTypeFallbackLabel(t: ITPTemplatePoint["type"]): string {
  switch (t) {
    case "photo":
      return "Photo";
    case "value":
      return "Value";
    case "signoff":
      return "Sign-off";
    case "note":
      return "Note";
  }
}

function pointTypeHint(p: ITPTemplatePoint): string | null {
  if (p.type === "photo") return "Take a photo of the point.";
  if (p.type === "value") {
    if (p.unit) return `Enter the measured ${p.unit} reading.`;
    return "Enter the measured value.";
  }
  if (p.type === "signoff") return "Confirm this point is complete.";
  if (p.type === "note") return "Add a note for this point.";
  return null;
}

function formatPassHint(
  min: number | null,
  max: number | null,
  unit: string | null,
): string | null {
  const u = unit ? ` ${unit}` : "";
  if (min != null && max != null) return `Pass: ${min}–${max}${u}`;
  if (min != null) return `Pass: ≥ ${min}${u}`;
  if (max != null) return `Pass: ≤ ${max}${u}`;
  return null;
}

function witnessRoleMatches(
  required: ITPTemplatePoint["witnessRole"],
  viewer: { id: string; role: string },
): boolean {
  if (!required) return true;
  if (required === "admin") return isAdminRole(viewer.role);
  if (required === "lh")
    return isLeadingHandRole(viewer.role) || isAdminRole(viewer.role);
  if (required === "builder")
    return (
      isAdminRole(viewer.role) ||
      isLeadingHandRole(viewer.role) ||
      isFieldRole(viewer.role)
    );
  return false;
}

function witnessRoleLabel(role: ITPTemplatePoint["witnessRole"]): string {
  if (role === "admin") return "an admin";
  if (role === "lh") return "a leading hand or admin";
  if (role === "builder") return "the builder";
  return "the right person";
}

function formatRelativeShort(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const deltaMs = Date.now() - t;
    if (deltaMs < 60_000) return "just now";
    const m = Math.round(deltaMs / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
  } catch {
    return "";
  }
}
