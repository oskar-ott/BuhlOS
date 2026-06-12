"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Search } from "lucide-react";
import {
  flattenGroups,
  groupResults,
  searchAll,
  type SearchGroup,
  type SearchResult,
} from "@/domains/search/client";
import { cn } from "@/lib/cn";

/**
 * Universal admin search (#188) — the topbar's first (and only) interactive
 * element. Type ≥2 chars → debounced GET /api/search → grouped Jobs / Snags
 * / People with deep links. Keyboard-first: "/" focuses, arrows + Enter
 * select, Esc closes.
 *
 * Visibility is the SERVER's (admin all, LH assigned) — this never merges or
 * widens results client-side. Out-of-order responses can't render: every
 * keystroke aborts the in-flight request.
 *
 * "search failed" (error chip) is kept distinct from "no matches" — never a
 * silent blank, matching the repo's loadSnapshot honesty convention.
 */

const DEBOUNCE_MS = 200;
const MIN_CHARS = 2;

type Status = "idle" | "loading" | "ready" | "error";

export function AdminSearchBox() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const flat = flattenGroups(groups);

  // "/" focuses the box — but never while the user is typing in another
  // field (input-suppression rule), and never with a modifier held.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced fetch, abort-on-keystroke.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      abortRef.current?.abort();
      setStatus("idle");
      setGroups([]);
      setActiveIndex(-1);
      return;
    }
    setStatus("loading");
    const handle = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await searchAll(q, controller.signal);
      if (controller.signal.aborted) return; // a newer keystroke won
      if (!res.ok) {
        // An aborted fetch surfaces as an error in some clients — ignore it,
        // the newer request owns the UI.
        if (controller.signal.aborted) return;
        setStatus("error");
        setGroups([]);
        setActiveIndex(-1);
        return;
      }
      setGroups(groupResults(res.data.results));
      setStatus("ready");
      setActiveIndex(-1);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const go = useCallback(
    (result: SearchResult | undefined) => {
      if (!result?.url) return;
      close();
      setQuery("");
      router.push(result.url as Route);
    },
    [router, close]
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (open && query) {
        close();
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (!open || flat.length === 0) {
      if (e.key === "Enter") e.preventDefault(); // no selection → no-op
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? flat.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[activeIndex] ?? flat[0]);
    }
  }

  const showPanel = open && query.trim().length >= MIN_CHARS;
  let flatCursor = -1;

  return (
    <div className="relative w-full max-w-xs">
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-2.5 focus-within:border-brand-navy">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(close, 150)} // allow click-through
          onKeyDown={onKeyDown}
          placeholder="Search jobs, snags, people…"
          aria-label="Search"
          data-testid="admin-search-input"
          className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-text-muted"
        />
        <kbd className="hidden shrink-0 rounded border border-border px-1 font-mono text-[10px] text-text-muted sm:block">
          /
        </kbd>
      </div>

      {showPanel ? (
        <div
          role="listbox"
          aria-label="Search results"
          data-testid="admin-search-panel"
          className="absolute right-0 z-50 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-card border border-border bg-surface-raised p-1 shadow-card"
        >
          {status === "loading" ? (
            <p className="px-3 py-2 text-sm text-text-muted">Searching…</p>
          ) : status === "error" ? (
            <p
              role="alert"
              data-testid="admin-search-error"
              className="m-1 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              Search failed — check your connection and try again.
            </p>
          ) : flat.length === 0 ? (
            <p className="px-3 py-2 text-sm text-text-muted" data-testid="admin-search-empty">
              No matches for &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.type} className="py-1">
                <p className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  {group.label}
                </p>
                <ul>
                  {group.results.map((result) => {
                    flatCursor += 1;
                    const idx = flatCursor;
                    const active = idx === activeIndex;
                    return (
                      <li key={`${result.type}:${result.id}`}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          // onMouseDown (not onClick) so it fires before the
                          // input's blur-close swallows the interaction.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            go(result);
                          }}
                          onMouseEnter={() => setActiveIndex(idx)}
                          disabled={!result.url}
                          className={cn(
                            "flex w-full flex-col items-start rounded-card px-3 py-1.5 text-left",
                            active ? "bg-surface-subtle" : "hover:bg-surface-subtle",
                            !result.url && "cursor-default opacity-60"
                          )}
                        >
                          <span className="line-clamp-1 text-sm text-text">{result.label}</span>
                          {result.sub ? (
                            <span className="line-clamp-1 text-xs text-text-muted">{result.sub}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
