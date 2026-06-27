"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { fetchCertificates } from "@/domains/certificates/client";
import { CERTIFICATE_TYPE_LABEL, type Certificate } from "@/domains/certificates/schema";
import { sortByIssuedDesc } from "@/domains/certificates/sort";

/**
 * Phil job-home Certificates section (#231) — READ-ONLY (no approval workflow).
 * Hidden-until-real (P10): self-fetches after hydration, is only ever MOUNTED
 * when the certificates_register flag is on (the home server page gates the
 * mount, env-only, off the LCP path), and renders NOTHING until certs exist.
 */
export function PhilCertificatesHomeSection({ jobId }: { jobId: string }) {
  const [certs, setCerts] = useState<Certificate[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCertificates(jobId)
      .then((r) => {
        if (alive) setCerts(r.certificates);
      })
      .catch(() => {
        if (alive) setCerts([]);
      });
    return () => {
      alive = false;
    };
  }, [jobId]);

  if (!certs || certs.length === 0) return null; // hidden until real

  const sorted = sortByIssuedDesc(certs);
  return (
    <section id="phil-job-certificates" aria-label="Certificates" className="scroll-mt-16">
      <Card>
        <CardTitle>Certificates</CardTitle>
        <CardDescription className="mt-1">
          Compliance + commissioning records for this job.
        </CardDescription>
        <ul className="mt-3 divide-y divide-border">
          {sorted.map((c) => (
            <li key={c.id} className="py-2">
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-[44px] items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-text">{c.title}</span>
                  <span className="block text-xs text-text-subtle">
                    {CERTIFICATE_TYPE_LABEL[c.type]}
                    {c.referenceNo ? ` · ${c.referenceNo}` : ""}
                    {c.issuedAt ? ` · ${c.issuedAt}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium text-accent">Open</span>
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
