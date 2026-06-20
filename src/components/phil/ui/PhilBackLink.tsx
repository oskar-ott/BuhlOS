import type { ReactNode } from "react";
import type { Route } from "next";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { PhilOfflineLink } from "@/components/phil/PhilOfflineLink";

interface PhilBackLinkProps {
  href: Route | string;
  children: ReactNode;
  className?: string;
}

/**
 * Consistent "← back" link for Phil sub-pages.
 *
 * Replaces the ad-hoc `text-sm` underlined back-links (My gear / Hours / job
 * detail) that each had a ~20px tap area. Guarantees a ≥44px hit target with
 * a leading chevron and the brand yellow underline accent.
 */
export function PhilBackLink({ href, children, className }: PhilBackLinkProps) {
  return (
    <PhilOfflineLink
      href={href as Route}
      className={cn(
        "-ml-1 inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-brand-navy",
        "underline decoration-accent-yellow decoration-2 underline-offset-4",
        className,
      )}
    >
      <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
      {children}
    </PhilOfflineLink>
  );
}
