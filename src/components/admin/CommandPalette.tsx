"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Search, CornerDownLeft } from "lucide-react";
import {
  flattenGroups,
  groupResults,
  searchAll,
  type SearchGroup,
} from "@/domains/search/client";
import { readRecentItems, type RecentItem } from "@/lib/storage/recent-items";
import {
  buildStaticSections,
  flattenSections,
  moveHighlight,
  shouldOpenFromKey,
  PALETTE_MIN_CHARS,
  type PaletteCommand,
  type PaletteSection,
} from "./command-palette-model";
import { cn } from "@/lib/cn";

/**
 * ⌘K command palette (#215) — the admin keyboard command layer.
 *
 * Empty state: Go to (every NAV destination + the hours sub-tabs + notification
 * settings), Actions (navigational shortcuts), and Recent (device-local ring
 * buffer; omitted when empty — never a "no recents" scold). Type ≥2 chars and
 * the static sections give way to live Results from the SAME endpoint the
 * topbar search uses (GET /api/search, server-scoped, debounced, out-of-order
 * safe) — ⌘K reuses the search domain rather than forking it.
 *
 * It is purely navigational: Enter / click pushes a route. Nothing here writes.
 * All derivation + keyboard math + the open-precedence rule live in
 * ./command-palette-model.ts (pure, unit-tested); this is the chrome.
 *
 * a11y mirrors AdminSearchBox: role="dialog" (labelled) wrapping a combobox
 * input + a role="listbox" of role="option" rows; ↑/↓ move the highlight,
 * Enter activates it, Esc closes and returns focus to where it was.
 *
 * Open precedence (see shouldOpenFromKey): ⌘K is suppressed while another
 * drawer/modal owns the screen (it keeps its own Esc); ⌘K is NOT suppressed
 * while typing in a field (the chord is unambiguous with a modifier held).
 */

const DEBOUNCE_MS = 200;
type SearchStatus = "idle" | "loading" | "ready" | "error";

/** True when any drawer/modal is open (they all render aria-modal="true").
 *  Used so ⌘K doesn't layer the palette over a drawer that owns focus + Esc. */
function anyModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[aria-modal="true"]') !== null;
}

export function CommandPalette() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Element focused before the palette opened, restored on close. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const [searchGroups, setSearchGroups] = useState<SearchGroup[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = query.trim();
  const searching = trimmed.length >= PALETTE_MIN_CHARS;

  // Static (non-search) sections; recents only present when non-empty.
  const staticSections = useMemo<PaletteSection[]>(
    () => buildStaticSections(recents),
    [recents]
  );

  // Search results promoted to palette commands so keyboard nav is uniform.
  const resultCommands = useMemo<PaletteCommand[]>(
    () =>
      flattenGroups(searchGroups)
        .filter((r) => !!r.url)
        .map((r) => ({
          id: `result:${r.type}:${r.id}`,
          label: r.label,
          hint: r.sub,
          href: r.url as Route,
          // Reuse the row's intrinsic icon vocabulary via a neutral marker;
          // search rows render their label/sub, the leading glyph is Search.
          icon: Search,
        })),
    [searchGroups]
  );

  // The flat, keyboard-walkable command list for the CURRENT mode.
  const flat = useMemo<PaletteCommand[]>(
    () => (searching ? resultCommands : flattenSections(staticSections)),
    [searching, resultCommands, staticSections]
  );

  const close = useCallback(() => {
    setOpen(false);
    abortRef.current?.abort();
    // Return focus to wherever it was when the palette opened (#215 AC).
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el && typeof el.focus === "function") el.focus();
  }, []);

  const activate = useCallback(
    (command: PaletteCommand | undefined) => {
      if (!command) return;
      setOpen(false);
      restoreFocusRef.current = null;
      setQuery("");
      router.push(command.href);
    },
    [router]
  );

  // Global ⌘K / Ctrl+K to open (precedence in shouldOpenFromKey). On open we
  // snapshot recents (so the empty state is fresh) and remember focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shouldOpenFromKey(e, anyModalOpen())) {
        e.preventDefault();
        if (!open) {
          restoreFocusRef.current =
            (document.activeElement as HTMLElement | null) ?? null;
          setRecents(readRecentItems());
          setQuery("");
          setActiveIndex(0);
          setOpen(true);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the input when the palette opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced search, abort-on-keystroke, out-of-order-safe — mirrors
  // AdminSearchBox so the two surfaces behave identically.
  useEffect(() => {
    if (!open) return;
    if (!searching) {
      abortRef.current?.abort();
      setSearchStatus("idle");
      setSearchGroups([]);
      return;
    }
    setSearchStatus("loading");
    const handle = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await searchAll(trimmed, controller.signal);
      if (controller.signal.aborted) return; // a newer keystroke won
      if (!res.ok) {
        if (controller.signal.aborted) return;
        setSearchStatus("error");
        setSearchGroups([]);
        return;
      }
      setSearchGroups(groupResults(res.data.results));
      setSearchStatus("ready");
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [open, searching, trimmed]);

  // Keep the highlight in range as the visible command set changes.
  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(Math.max(i, 0), flat.length - 1)));
  }, [flat.length]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => moveHighlight(i, 1, flat.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => moveHighlight(i, -1, flat.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(flat[activeIndex]);
    }
  }

  if (!open) return null;

  // Render-time cursor so each option's index lines up with `flat`/activeIndex.
  let cursor = -1;
  const renderRow = (command: PaletteCommand) => {
    cursor += 1;
    const idx = cursor;
    const isActive = idx === activeIndex;
    const Icon = command.icon;
    return (
      <li key={command.id}>
        <button
          type="button"
          role="option"
          aria-selected={isActive}
          data-active={isActive ? "true" : undefined}
          // onMouseDown (not onClick): fire before any blur/close swallows it.
          onMouseDown={(e) => {
            e.preventDefault();
            activate(command);
          }}
          onMouseEnter={() => setActiveIndex(idx)}
          className={cn(
            "flex w-full items-center gap-3 rounded-card px-3 py-2 text-left",
            isActive ? "bg-surface-subtle" : "hover:bg-surface-subtle"
          )}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm text-text">{command.label}</span>
          {command.hint ? (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-muted">
              {command.hint}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-testid="admin-command-palette"
      // Backdrop. z-[60] sits above drawers (z-50) — though ⌘K is suppressed
      // while a drawer is open, click-launched recents could still race; the
      // higher layer keeps the palette usable if it ever co-exists.
      className="fixed inset-0 z-[60] flex items-start justify-center bg-accent-ink/40 px-4 pt-[12vh]"
      onMouseDown={close}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-border bg-surface-raised shadow-card"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="admin-command-list"
            aria-label="Type a command or search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder="Jump to a page, run an action, or search…"
            data-testid="admin-command-input"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-text-muted"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1 font-mono text-[10px] text-text-muted sm:block">
            esc
          </kbd>
        </div>

        <div
          id="admin-command-list"
          role="listbox"
          aria-label="Commands"
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          {searching ? (
            searchStatus === "loading" ? (
              <p className="px-3 py-2 text-sm text-text-muted">Searching…</p>
            ) : searchStatus === "error" ? (
              <p
                role="alert"
                data-testid="admin-command-error"
                className="m-1 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
              >
                Search failed — check your connection and try again.
              </p>
            ) : flat.length === 0 ? (
              <p className="px-3 py-2 text-sm text-text-muted" data-testid="admin-command-empty">
                No matches for &ldquo;{trimmed}&rdquo;.
              </p>
            ) : (
              <div className="py-1">
                <p className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Results
                </p>
                <ul>{flat.map(renderRow)}</ul>
              </div>
            )
          ) : (
            staticSections.map((section) => (
              <div key={section.id} className="py-1" data-section={section.id}>
                <p className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  {section.heading}
                </p>
                <ul>{section.commands.map(renderRow)}</ul>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[10px] text-text-muted">
          <span className="flex items-center gap-1">
            <CornerDownLeft aria-hidden="true" className="h-3 w-3" /> to open
          </span>
          <span>↑↓ to move</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
