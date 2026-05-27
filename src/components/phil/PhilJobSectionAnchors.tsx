"use client";

import {
  AlertOctagon,
  Camera,
  ClipboardCheck,
  FileText,
  Layers,
  MapPin,
  Package,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface AnchorSection {
  id: string;
  label: string;
  icon: typeof Camera;
  /** Optional small count chip. We render the chip when the count is > 0
   *  — otherwise the row stays clean (a row that says "Snags 0" reads
   *  worse than no count at all). */
  count?: number;
  /** When true, render the row as a muted UC anchor — still scrolls but
   *  the chip reads "UC" instead of the count. */
  uc?: boolean;
}

interface Props {
  /** Whether site context is rendered above (so the Site anchor only
   *  appears when there's somewhere for it to jump to). */
  hasSite: boolean;
  /** Whether the stage/area picker block is rendered (the page hides it
   *  when the job has no areas). */
  hasAreas: boolean;
  /** Live counts from the data we already loaded. Undefined = skip the
   *  chip; 0 = render the row without a chip (avoids zero-noise). */
  snagsActive: number;
  itpsActive: number;
}

/**
 * Phil — In-page section anchors.
 *
 * The Phil job interface is one long scroll surface — site, capture,
 * snags, ITPs, documents, materials, history all on the same page. The
 * Bible's five-tab pattern (Home · Work · Capture · Info · Activity)
 * presupposes a separate-screen-per-tab restructure; this anchor strip
 * is the small version of that idea: a row of chips that scrolls to the
 * relevant section without leaving the page.
 *
 * Rendered as a horizontal scrolling chip strip on small screens so it
 * stays one-row on a phone without truncating any chip. Each chip is a
 * plain `<a href="#...">` so it works with the browser's smooth-scroll
 * behaviour and survives a Phil-app refresh.
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §04
 *   src/components/admin/JobInterfaceSectionNav.tsx — admin precedent
 */
export function PhilJobSectionAnchors({
  hasSite,
  hasAreas,
  snagsActive,
  itpsActive,
}: Props) {
  const maybe: ReadonlyArray<AnchorSection | null> = [
    hasSite ? { id: "phil-job-site", label: "Site", icon: MapPin } : null,
    hasAreas ? { id: "phil-job-work", label: "Work", icon: Layers } : null,
    { id: "phil-job-capture", label: "Capture", icon: Camera },
    {
      id: "phil-job-snags",
      label: "Snags",
      icon: AlertOctagon,
      count: snagsActive,
    },
    {
      id: "phil-job-itps",
      label: "ITPs",
      icon: ClipboardCheck,
      count: itpsActive,
    },
    {
      id: "phil-job-documents",
      label: "Site files",
      icon: FileText,
      uc: true,
    },
    {
      id: "phil-job-materials",
      label: "Materials",
      icon: Package,
      uc: true,
    },
  ];
  const sections: ReadonlyArray<AnchorSection> = maybe.filter(
    (s): s is AnchorSection => s !== null,
  );

  return (
    <nav
      aria-label="Job sections"
      className="-mx-4 overflow-x-auto px-4 pb-1 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex w-max gap-2">
        {sections.map((section) => (
          <li key={section.id}>
            <AnchorChip section={section} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function AnchorChip({ section }: { section: AnchorSection }) {
  const Icon = section.icon;
  const showCount =
    typeof section.count === "number" && section.count > 0 && !section.uc;
  return (
    <a
      href={`#${section.id}`}
      className={cn(
        "flex min-h-[40px] items-center gap-1.5 rounded-pill border px-3 py-1.5 text-sm",
        "border-border bg-surface text-text",
        "hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy",
        section.uc ? "text-text-muted" : "",
      )}
      aria-label={
        section.uc
          ? `Scroll to ${section.label} (under construction)`
          : `Scroll to ${section.label}`
      }
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "h-4 w-4 shrink-0",
          section.uc ? "text-text-muted/70" : "text-text-muted",
        )}
      />
      <span className="font-display font-medium">{section.label}</span>
      {section.uc ? (
        <span className="rounded-pill border border-border bg-surface-subtle px-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
          UC
        </span>
      ) : showCount ? (
        <span className="rounded-pill bg-brand-navy px-1.5 text-[11px] font-semibold text-text-inverse">
          {section.count}
        </span>
      ) : null}
    </a>
  );
}
