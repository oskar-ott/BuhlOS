import Link from "next/link";
import type { Route } from "next";
import { Eye, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Office / Field segmented toggle on the job hub (mobile-admin redesign,
 * flagged admin_job_field_view). The selected view is driven by the URL
 * (?view=field) so the server render stays authoritative — no client state.
 * Only rendered when the flag is on for an admin-tier viewer.
 */
export function JobViewToggle({ jobId, current }: { jobId: string; current: "office" | "field" }) {
  const base = `/v2/jobs/${encodeURIComponent(jobId)}`;
  return (
    <div
      role="tablist"
      aria-label="Job view"
      className="flex gap-1 rounded-card border border-border bg-surface-subtle p-1"
    >
      <ToggleLink href={base as Route} icon={LayoutGrid} label="Office view" active={current === "office"} />
      <ToggleLink
        href={`${base}?view=field` as Route}
        icon={Eye}
        label="Field view"
        active={current === "field"}
      />
    </div>
  );
}

function ToggleLink({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: Route;
  icon: typeof Eye;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={cn(
        "inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-card px-3 text-sm font-medium",
        active
          ? "bg-surface text-brand-navy shadow-card"
          : "text-text-muted hover:text-text",
      )}
    >
      <Icon aria-hidden="true" className={cn("h-4 w-4", active ? "text-accent-yellow" : "")} />
      {label}
    </Link>
  );
}
