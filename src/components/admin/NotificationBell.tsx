"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import {
  isUnread,
  unreadCount,
  type NotificationItem,
} from "@/domains/platform/notification-item";

/**
 * Notification bell (#218, Epic 18) — the RECOVERY surface for pushes. A push
 * dismissed at the smoko table is gone; the bell is where you get it back.
 *
 * ⚠️ NOT MOUNTED ANYWHERE — ON PURPOSE. This component is built and
 * render-tested against `NotificationItem` FIXTURES so it's ready, but it is
 * deliberately not imported by any page or shell. The hide-unfinished rule
 * forbids dead chrome: a real, viewer-scoped feed endpoint does not exist yet
 * (it lands with Epic 18 / #220). Mounting the bell is a ONE-LINE follow-up at
 * that point — drop it in the AdminTopbar and feed it the endpoint's items.
 * Until then it must stay out of the tree. `NotificationBell.render.test.tsx`
 * also asserts (by construction) that nothing imports it as live chrome.
 *
 * Contract notes:
 *   - the bell takes its `items` as INPUT and is VIEWER-SCOPED — an office bell
 *     is handed office-tier items only. It never fetches a global all-users
 *     feed.
 *   - `deepLink`s are MODERN routes (see docs/notifications.md §8).
 *   - no websockets/polling here — when mounted, the parent supplies items on
 *     the command-centre cadence.
 */
export function NotificationBell({
  items,
  open = false,
  error = false,
  onToggleOpen,
  onMarkRead,
  onMarkAllRead,
}: {
  /** Viewer-scoped feed rows (newest first). */
  items: ReadonlyArray<NotificationItem>;
  /** Whether the dropdown is open (controlled by the parent). */
  open?: boolean;
  /** Render the error state instead of the list. */
  error?: boolean;
  onToggleOpen?: () => void;
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
}) {
  const unread = unreadCount(items);

  return (
    <div className="relative" data-testid="notification-bell">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        data-testid="notification-bell-button"
        onClick={onToggleOpen}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle hover:text-text"
      >
        <Bell aria-hidden="true" className="h-5 w-5" />
        {unread > 0 ? (
          <span
            data-testid="notification-bell-badge"
            className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-state-danger px-1 text-[10px] font-semibold leading-4 text-text-inverse"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="notification-bell-dropdown"
          role="menu"
          className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-card border border-border bg-surface-raised shadow-card"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <p className="font-display text-sm text-text">Notifications</p>
            {unread > 0 ? (
              <button
                type="button"
                data-testid="notification-bell-mark-all"
                onClick={onMarkAllRead}
                className="text-xs font-medium text-brand-navy hover:underline"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          {error ? (
            <div
              data-testid="notification-bell-error"
              role="alert"
              className="px-4 py-6 text-sm text-text-muted"
            >
              {"We couldn't load your notifications. Try again in a moment."}
            </div>
          ) : items.length === 0 ? (
            <div
              data-testid="notification-bell-empty"
              className="px-4 py-8 text-center text-sm text-text-muted"
            >
              {"You're all caught up."}
            </div>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {items.map((item) => {
                const unreadRow = isUnread(item);
                const body = (
                  <div className="flex items-start gap-2">
                    {unreadRow ? (
                      <span
                        aria-hidden="true"
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-navy"
                      />
                    ) : (
                      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "truncate text-sm",
                          unreadRow ? "font-medium text-text" : "text-text-muted",
                        )}
                      >
                        {item.title}
                      </p>
                      <p className="text-xs text-text-muted">
                        {new Date(item.occurredAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}
                      </p>
                    </div>
                  </div>
                );
                return (
                  <li key={item.id} data-testid={`notification-row-${item.id}`}>
                    <div className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-surface-subtle">
                      {item.deepLink ? (
                        <Link
                          href={item.deepLink as Route}
                          data-testid={`notification-link-${item.id}`}
                          className="min-w-0 flex-1"
                          onClick={() => onMarkRead?.(item.id)}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="min-w-0 flex-1">{body}</div>
                      )}
                      {unreadRow ? (
                        <button
                          type="button"
                          aria-label="Mark read"
                          data-testid={`notification-mark-${item.id}`}
                          onClick={() => onMarkRead?.(item.id)}
                          className="shrink-0 rounded-card px-2 py-1 text-xs text-brand-navy hover:underline"
                        >
                          Mark read
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
