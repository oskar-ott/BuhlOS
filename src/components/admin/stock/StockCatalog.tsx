"use client";

import { useState } from "react";
import { AlertTriangle, Check, MapPin, Package } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardLocation, cardSpecLine } from "@/domains/workshop-stock/catalog";
import {
  formatNumber,
  photoUrl,
  UNIT_LABEL,
  verificationLine,
  whenLabel,
} from "@/domains/workshop-stock/format";
import { groupByShelf } from "@/domains/workshop-stock/location";
import type { StockItem } from "@/domains/workshop-stock/schema";
import {
  typeLabel,
  type Facet,
  type FacetChoice,
  type TypeTile,
} from "@/domains/workshop-stock/types";

/**
 * /stock — the catalogue view: the workshop read like an online store. A card
 * per item with its photo large, brand over name, its fields, what's recorded
 * and where it lives; departments (the item types) and their filters down the
 * side. Clicking a card opens the same drawer the list does (the "quick view").
 * Nothing on a card is invented: no prices, ratings or "low stock" — the
 * record holds none of those (P7). docs/workshop-stock.md "The office catalogue".
 */

/** A product photo filling its frame: the small copy for most screens, the full photo where the card is large; a package when there's none. */
function CatalogPhoto({ photoId, alt }: { photoId: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!photoId || failed) {
    return (
      <div
        aria-hidden="true"
        className="flex h-full w-full items-center justify-center text-text-muted/60"
      >
        <Package className="h-12 w-12" strokeWidth={1.25} />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an authenticated same-origin proxy, not a static asset
    <img
      src={photoUrl(photoId, "thumb")}
      srcSet={`${photoUrl(photoId, "thumb")} 320w, ${photoUrl(photoId, "full")} 1600w`}
      sizes="(min-width: 1280px) 240px, (min-width: 640px) 30vw, 46vw"
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
    />
  );
}

function Availability({ item, archived }: { item: StockItem; archived: boolean }) {
  if (archived) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-text-muted">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-state-neutral-dot" />
        Archived {whenLabel(item.archivedAt)}
      </span>
    );
  }
  if (item.balanceMilli === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-state-warning-subtle-text">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-state-warning-dot" />
        None recorded
      </span>
    );
  }
  const unit = UNIT_LABEL[item.baseUnit];
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span
        aria-hidden="true"
        className="h-2 w-2 translate-y-[-1px] self-center rounded-full bg-state-success-dot"
      />
      <span className="font-display text-[17px] font-bold tabular-nums leading-none text-text">
        {item.estimated ? "≈ " : ""}
        {formatNumber(item.balanceMilli)}
      </span>{" "}
      <span className="text-[13px] font-medium text-text-muted">
        {item.balanceMilli === 1000 ? unit.singular : unit.plural}{" "}
        {item.estimated ? "· estimate" : "recorded"}
      </span>
    </span>
  );
}

function ProductCard({
  item,
  archived,
  showType,
  onOpen,
}: {
  item: StockItem;
  archived: boolean;
  showType: boolean;
  onOpen: (id: string) => void;
}) {
  const spec = cardSpecLine(item);
  const where = cardLocation(item.location);
  const type = showType ? typeLabel(item.category) : null;
  const confirmed = item.verificationStatus === "manufacturer_code_matched";
  return (
    <li className="flex">
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        data-testid="stock-admin-card"
        className="group flex w-full flex-col overflow-hidden rounded-card border border-border bg-surface text-left shadow-card transition duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <div
          className={cn(
            "relative aspect-square w-full overflow-hidden bg-surface-subtle",
            archived && "grayscale",
            !archived && item.balanceMilli === 0 && "opacity-60"
          )}
        >
          <CatalogPhoto photoId={item.photoId} alt={item.name} />
          {type ? (
            <span className="absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded-pill border border-border bg-surface/95 px-2 py-0.5 text-[11px] font-semibold text-text shadow-card backdrop-blur-sm">
              {type}
            </span>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col p-3">
          <span className="min-h-[16px] truncate font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">
            {item.brand || " "}
          </span>
          <span className="mt-0.5 line-clamp-2 font-display text-[15px] font-semibold leading-snug text-text group-hover:underline group-hover:decoration-accent-yellow group-hover:decoration-2 group-hover:underline-offset-2">
            {item.name}
          </span>
          {spec ? (
            <span className="mt-1 line-clamp-1 text-[12.5px] text-text-muted" title={spec}>
              {spec}
            </span>
          ) : null}
          <span className="flex-1" />
          <div className="mt-3 border-t border-border pt-2.5">
            <Availability item={item} archived={archived} />
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-text-muted">
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{where ?? "No shelf set"}</span>
              </span>
              {archived ? null : confirmed ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 text-state-success-subtle-text"
                  title={verificationLine(item)}
                >
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="sr-only">{verificationLine(item)}</span>
                  <span aria-hidden="true">Code</span>
                </span>
              ) : (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 text-state-warning-subtle-text"
                  title={verificationLine(item)}
                >
                  <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="sr-only">{verificationLine(item)}</span>
                  <span aria-hidden="true">Check code</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4";

/** The cards; in shelf order they sit under a heading per shelf, like aisles. */
export function CatalogGrid({
  items,
  archived,
  byShelf,
  showType,
  onOpen,
}: {
  items: StockItem[];
  archived: boolean;
  byShelf: boolean;
  showType: boolean;
  onOpen: (id: string) => void;
}) {
  if (!byShelf) {
    return (
      <ul className={GRID} data-testid="stock-admin-catalog">
        {items.map((i) => (
          <ProductCard
            key={i.id}
            item={i}
            archived={archived}
            showType={showType}
            onOpen={onOpen}
          />
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-6" data-testid="stock-admin-catalog">
      {groupByShelf(items).map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="mb-2.5 flex items-baseline gap-2 border-b border-border pb-1.5">
            <span className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-text">
              {g.label}
            </span>
            <span className="text-xs text-text-muted">
              {g.items.length} {g.items.length === 1 ? "item" : "items"}
            </span>
          </h3>
          <ul className={GRID}>
            {g.items.map((i) => (
              <ProductCard
                key={i.id}
                item={i}
                archived={archived}
                showType={showType}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Departments (one per item type in view, with its count) and, once one is
 * picked, its filters — brand, range, gang, colour temperature… built from
 * what's actually in stock (types.ts facetsFor), each value with how many
 * items it leaves. A column on a wide screen; a scrolling row above the cards
 * on a narrow one.
 */
export function CatalogDepartments({
  tiles,
  total,
  active,
  onPick,
  facets,
  choice,
  onChoose,
}: {
  tiles: TypeTile[];
  total: number;
  active: string;
  onPick: (key: string) => void;
  facets: Facet[];
  choice: FacetChoice;
  onChoose: (fieldKey: string, valueKey: string | null) => void;
}) {
  const departments = [
    { key: "", label: "All departments", count: total },
    ...tiles.map((t) => ({ key: t.key ?? "", label: t.label, count: t.count })),
  ];
  return (
    <nav aria-label="Departments" className="space-y-5" data-testid="stock-admin-departments">
      {/* narrow: a row of chips */}
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:hidden">
        {departments.map((d) => (
          <button
            key={d.key || "all"}
            type="button"
            aria-pressed={d.key === active}
            onClick={() => onPick(d.key)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border px-3 text-[13px] font-medium",
              d.key === active
                ? "border-brand-navy bg-brand-navy text-text-inverse"
                : "border-border bg-surface text-text hover:border-border-strong"
            )}
          >
            {d.key ? d.label : "All"}
            <span
              className={cn(
                "font-mono text-[11px] tabular-nums",
                d.key === active ? "text-text-inverse/80" : "text-text-muted"
              )}
            >
              {d.count}
            </span>
          </button>
        ))}
      </div>
      {/* wide: a list */}
      <div className="hidden lg:block">
        <p className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-muted">
          Departments
        </p>
        <ul className="space-y-0.5">
          {departments.map((d) => (
            <li key={d.key || "all"}>
              <button
                type="button"
                aria-pressed={d.key === active}
                onClick={() => onPick(d.key)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[13.5px]",
                  d.key === active
                    ? "bg-brand-navy font-semibold text-text-inverse"
                    : "text-text hover:bg-surface-subtle"
                )}
              >
                <span className="truncate">{d.label}</span>
                <span
                  className={cn(
                    "font-mono text-[11px] tabular-nums",
                    d.key === active ? "text-text-inverse/80" : "text-text-muted"
                  )}
                >
                  {d.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {facets.length ? (
        <div className="space-y-4" data-testid="stock-admin-facets">
          {facets.map((f) => (
            <fieldset key={f.field.key}>
              <legend className="mb-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-muted">
                {f.field.label}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {f.values.map((v) => {
                  const on = choice[f.field.key] === v.key;
                  return (
                    <button
                      key={v.key}
                      type="button"
                      aria-pressed={on}
                      disabled={!on && v.count === 0}
                      onClick={() => onChoose(f.field.key, on ? null : v.key)}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-pill border px-2.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                        on
                          ? "border-brand-navy bg-brand-navy text-text-inverse"
                          : "border-border bg-surface text-text hover:border-border-strong"
                      )}
                    >
                      {v.value}
                      <span
                        className={cn(
                          "font-mono text-[10.5px] tabular-nums",
                          on ? "text-text-inverse/80" : "text-text-muted"
                        )}
                      >
                        {v.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
