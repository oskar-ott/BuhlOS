"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { GEAR_ASSET_TYPES } from "@/domains/gear/schema";
import { createGearAsset, updateGearAsset } from "@/domains/gear/client";
import { typeLabel } from "@/domains/gear/format";
import type { GearAsset, GearHolderUser } from "@/domains/gear/types";

/**
 * Create / edit-metadata sheet for the gear register (#389) — the modern
 * replacement for the asset editor the legacy cutover deleted. One form,
 * two modes:
 *
 *   create — name/type/identifier/notes + hired-gear fields + optional
 *            create-and-assign (holder picker; the API enforces the same
 *            field/LH-only holder rules as transfer).
 *   edit   — the same metadata via PUT. Holder changes are deliberately
 *            NOT here (the server rejects them on PUT) — assignment stays
 *            on the drawer's Transfer flow so history is always written.
 *
 * Admin-tier only by placement: /gear redirects non-admins, and the API
 * re-checks every call.
 */

interface Props {
  mode: "create" | "edit";
  asset?: GearAsset;
  holders: ReadonlyArray<GearHolderUser>;
  onClose: () => void;
  onSaved: () => void;
}

export function AssetEditorSheet({ mode, asset, holders, onClose, onSaved }: Props) {
  const [name, setName] = useState(asset?.name ?? "");
  const [type, setType] = useState<string>(asset?.type ?? "tool");
  const [identifier, setIdentifier] = useState(asset?.identifier ?? "");
  const [notes, setNotes] = useState(asset?.notes ?? "");
  const [ownership, setOwnership] = useState<"owned" | "hired">(asset?.ownership ?? "owned");
  const [hireEndDate, setHireEndDate] = useState(asset?.hireEndDate ?? "");
  const [hireRate, setHireRate] = useState(
    asset?.hireRateExGst != null ? String(asset.hireRateExGst) : "",
  );
  const [hireSupplier, setHireSupplier] = useState(asset?.hireSupplier ?? "");
  const [holderId, setHolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const inputClass = "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm";

  async function save() {
    setErrorMessage(null);
    if (!name.trim()) {
      setErrorMessage("Name is required.");
      return;
    }
    setBusy(true);
    const hire =
      ownership === "hired"
        ? {
            hireEndDate: hireEndDate || null,
            hireRateExGst: hireRate === "" ? null : Number(hireRate),
            hireSupplier: hireSupplier.trim() || null,
          }
        : { hireEndDate: null, hireRateExGst: null, hireSupplier: null };
    const base = {
      name: name.trim(),
      type: type as (typeof GEAR_ASSET_TYPES)[number],
      identifier: identifier.trim() || null,
      notes: notes.trim() || null,
      ownership,
      ...hire,
    };
    const result =
      mode === "create"
        ? await createGearAsset({ ...base, currentHolderId: holderId || null })
        : await updateGearAsset(asset!.id, base);
    setBusy(false);
    if (!result.ok) {
      setErrorMessage(result.error.message);
      return;
    }
    onSaved();
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={mode === "create" ? "Add an asset" : `Edit ${asset?.name ?? "asset"}`}
      className="max-w-lg"
    >
      <div className="space-y-3 text-sm">
        {errorMessage ? (
          <p className="rounded-card border border-state-danger px-3 py-2 text-state-danger" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <label className="block">
          <span className="text-text-muted">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Makita 18V drill"
            className={inputClass}
            data-testid="asset-editor-name"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-text-muted">Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
              {GEAR_ASSET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-text-muted">Identifier / serial</span>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-text-muted">Ownership</span>
          <select
            value={ownership}
            onChange={(e) => setOwnership(e.target.value as "owned" | "hired")}
            className={inputClass}
            data-testid="asset-editor-ownership"
          >
            <option value="owned">Owned (company asset)</option>
            <option value="hired">Hired (rental)</option>
          </select>
        </label>

        {ownership === "hired" ? (
          <div className="space-y-3 rounded-card border border-border p-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-text-muted">Hire end date</span>
                <input
                  type="date"
                  value={hireEndDate}
                  onChange={(e) => setHireEndDate(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-text-muted">Day rate ex-GST ($)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={hireRate}
                  onChange={(e) => setHireRate(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block">
              <span className="text-text-muted">Hire supplier</span>
              <input
                type="text"
                value={hireSupplier}
                onChange={(e) => setHireSupplier(e.target.value)}
                placeholder="e.g. Coates Hire"
                className={inputClass}
              />
            </label>
          </div>
        ) : null}

        {mode === "create" ? (
          <label className="block">
            <span className="text-text-muted">Assign to (optional)</span>
            <select
              value={holderId}
              onChange={(e) => setHolderId(e.target.value)}
              className={inputClass}
              data-testid="asset-editor-holder"
            >
              <option value="">— Into the depot —</option>
              {holders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.username}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-text-muted">
            Holder changes happen via Transfer on the asset drawer, so every move lands in the
            history.
          </p>
        )}

        <label className="block">
          <span className="text-text-muted">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={() => void save()}
            disabled={busy || !name.trim()}
            data-testid="asset-editor-save"
          >
            {busy ? "Saving…" : mode === "create" ? "Add asset" : "Save changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
