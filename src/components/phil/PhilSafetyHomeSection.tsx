"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { fetchSafetyDocs } from "@/domains/safety-docs/client";
import type { SafetyDoc } from "@/domains/safety-docs/schema";

/**
 * Phil job-home Safety section (#219), hidden-until-real (P10). Self-fetches
 * after hydration — it is only ever MOUNTED when the safety_docs flag is on
 * (the home server page gates the mount, env-only, off the LCP path), and it
 * renders NOTHING until docs are present, so an empty job shows no Safety
 * clutter. The full read-and-acknowledge surface lives at the /safety sub-route.
 */
export function PhilSafetyHomeSection({ jobId }: { jobId: string }) {
  const [docs, setDocs] = useState<SafetyDoc[] | null>(null);
  const [ackedCount, setAckedCount] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchSafetyDocs(jobId)
      .then((r) => {
        if (!alive) return;
        setDocs(r.documents);
        setAckedCount((r.acknowledgedDocIds ?? []).length);
      })
      .catch(() => {
        if (alive) setDocs([]);
      });
    return () => {
      alive = false;
    };
  }, [jobId]);

  if (!docs || docs.length === 0) return null; // hidden until real

  const toRead = docs.length - ackedCount;
  return (
    <section id="phil-job-safety" aria-label="Safety" className="scroll-mt-16">
      <Card>
        <CardTitle>Safety</CardTitle>
        <CardDescription className="mt-1">
          {toRead > 0
            ? `${toRead} safety ${toRead === 1 ? "document" : "documents"} to read and acknowledge.`
            : "All safety documents acknowledged."}
        </CardDescription>
        <div className="mt-3">
          <PhilOfflineLink
            href={`/phil/jobs/${encodeURIComponent(jobId)}/safety`}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
          >
            <ShieldCheck aria-hidden="true" className="h-5 w-5" />
            Open safety docs
          </PhilOfflineLink>
        </div>
      </Card>
    </section>
  );
}
