"use client";

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  KeyRound,
  MapPin,
  Phone,
  ShieldAlert,
  Squircle,
  User,
} from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { PhilNotice } from "./ui/PhilNotice";
import { hasSiteContext } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

/**
 * Phil — Site details card.
 *
 * Reference info for the job: address, contact, access, parking, safety and the
 * induction flag. Collapsible. Extracted from PhilJobDetail and moved to the
 * bottom "reference" zone of the job screen so the active work loop — Work +
 * Capture — leads the page instead of being pushed down by an open Site card.
 * Renders nothing when the job has no site context.
 *
 * Keeps `id="phil-job-site"` so the attention strip's "Site induction required"
 * item still scrolls here (PhilJobAttention.deriveAttention → `#phil-job-site`).
 */
export function PhilJobSiteCard({ job }: { job: Job }) {
  const [open, setOpen] = useState(true);
  if (!hasSiteContext(job)) return null;

  return (
    <section
      id="phil-job-site"
      aria-labelledby="phil-job-site-h"
      className="scroll-mt-16"
    >
      <Card>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={open}
          aria-controls="phil-job-site-body"
        >
          <CardTitle className="m-0">
            <span id="phil-job-site-h">Site details</span>
          </CardTitle>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-5 w-5 shrink-0 text-text-muted transition-transform",
              open ? "rotate-180" : "",
            )}
          />
        </button>
        {open ? (
          <dl id="phil-job-site-body" className="mt-3 space-y-3 text-sm">
            {job.siteAddress ? (
              <SiteField icon={<MapPin className="h-4 w-4" />} label="Address">
                {job.siteAddress}
              </SiteField>
            ) : null}
            {job.siteContactName?.trim() || job.siteContactPhone?.trim() ? (
              <SiteField icon={<User className="h-4 w-4" />} label="Contact">
                {[
                  job.siteContactName?.trim(),
                  job.siteContactPhone?.trim() && (
                    <span key="phone" className="inline-flex items-center gap-1">
                      <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                      <a
                        href={`tel:${job.siteContactPhone!.replace(/\s+/g, "")}`}
                        className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                      >
                        {job.siteContactPhone!.trim()}
                      </a>
                    </span>
                  ),
                ]
                  .filter(Boolean)
                  .map((node, i) => (
                    <span key={i} className="block">
                      {node}
                    </span>
                  ))}
              </SiteField>
            ) : null}
            {job.accessNotes ? (
              <SiteField icon={<KeyRound className="h-4 w-4" />} label="Access">
                {job.accessNotes}
              </SiteField>
            ) : null}
            {job.parkingNotes ? (
              <SiteField icon={<Squircle className="h-4 w-4" />} label="Parking">
                {job.parkingNotes}
              </SiteField>
            ) : null}
            {job.safetyNotes ? (
              <SiteField icon={<ShieldAlert className="h-4 w-4" />} label="Safety">
                {job.safetyNotes}
              </SiteField>
            ) : null}
            {job.inductionRequired ? (
              <PhilNotice tone="warning" title="Site induction required">
                Confirm with your leading hand before starting.
              </PhilNotice>
            ) : null}
          </dl>
        ) : null}
      </Card>
    </section>
  );
}

function SiteField({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="font-display text-[11px] uppercase tracking-wider text-text-muted">
          {label}
        </dt>
        <dd className="mt-0.5 whitespace-pre-line break-words text-text">
          {children}
        </dd>
      </div>
    </div>
  );
}
