"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { binAt, binsOn, locationText, rackLabel, shelfLabel, type LocationMatrix } from "@/domains/workshop-stock/location-matrix";

const CHIP = "min-h-[36px] rounded-pill border px-3 text-[13px]";
const chip = (on: boolean) => cn(CHIP, on ? "border-brand-navy bg-brand-navy font-semibold text-white" : "border-border text-text hover:border-brand-navy");

/**
 * Rack, then shelf, then bin, for whoever is standing at it. Follows the location
 * already in the field, so a filled-in bin can be changed by one tap. Picking the
 * bin is what sets the location; a rack or shelf alone changes nothing.
 */
export function BinPicker({ matrix, location, onPick, disabled }: { matrix: LocationMatrix; location: string; onPick: (text: string) => void; disabled?: boolean }) {
  const [browsing, setBrowsing] = useState<{ rackId: string; shelf: number | null } | null>(null);
  const at = binAt(location, matrix);
  const rackId = browsing?.rackId ?? at?.rack.id ?? (matrix.racks.length === 1 ? matrix.racks[0]!.id : null);
  const rack = matrix.racks.find((r) => r.id === rackId) ?? null;
  const shelf = browsing ? browsing.shelf : at?.rack.id === rackId ? at?.shelf ?? null : null;
  const bin = !browsing || browsing.shelf === at?.shelf ? (at?.rack.id === rackId && at?.shelf === shelf ? at?.bin ?? null : null) : null;

  return (
    <div className="space-y-1.5" data-testid="stock-bin-picker">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Rack">
        {matrix.racks.map((r) => (
          <button key={r.id} type="button" disabled={disabled} aria-pressed={r.id === rackId} onClick={() => setBrowsing({ rackId: r.id, shelf: null })} className={chip(r.id === rackId)} data-testid="stock-bin-picker-rack">{rackLabel(r.name)}</button>
        ))}
      </div>
      {rack ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Shelf">
          {Array.from({ length: rack.shelves }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" disabled={disabled} aria-pressed={n === shelf} onClick={() => setBrowsing({ rackId: rack.id, shelf: n })} className={chip(n === shelf)} data-testid="stock-bin-picker-shelf">Shelf {shelfLabel(n)}</button>
          ))}
        </div>
      ) : null}
      {rack && shelf ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Bin">
          {Array.from({ length: binsOn(rack, shelf) }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" disabled={disabled} aria-pressed={n === bin} onClick={() => { onPick(locationText(rack, shelf, n)); setBrowsing(null); }} className={chip(n === bin)} data-testid="stock-bin-picker-bin">Bin {n}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
