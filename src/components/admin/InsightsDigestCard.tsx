"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * #347 — the insights digest card on /reports (flag ai_insights_digest,
 * admin-tier, dark by default — the page only renders this when the flag is
 * on for the viewer).
 *
 * Honesty contract, rendered:
 *   - every bullet links to the records behind it
 *   - the phrasing badge says whether AI reworded the findings or the
 *     deterministic template did (and why it fell back)
 *   - the footer states what the digest does and does NOT see
 *   - a quiet week says so — no filler insights
 */

export interface DigestBullet {
  text: string;
  href: string;
  findingKey: string;
}

export interface StoredDigest {
  weekStart: string;
  generatedAt: string;
  quietWeek: boolean;
  findings: Array<{ key: string; severity: "amber" | "red" }>;
  bullets: DigestBullet[];
  phrasing: "ai" | "deterministic" | "none";
  model: string | null;
  fallbackReason?: string | null;
  coverage?: { sees: string[]; doesNotSee: string[] };
}

interface Props {
  weekStart: string;
  digest: StoredDigest | null;
}

function severityFor(digest: StoredDigest, findingKey: string): "amber" | "red" {
  return digest.findings.find((f) => f.key === findingKey)?.severity === "red" ? "red" : "amber";
}

export function InsightsDigestCard({ weekStart, digest }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/insights-digest?action=generate", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error || `Generate failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Generate failed — network error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card data-testid="insights-digest-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>This week&rsquo;s insights</CardTitle>
          <CardDescription className="mt-1">
            AI-assisted digest of what changed — every number comes from
            deterministic checks over the company&rsquo;s records, and every
            line links to them. Week starting {weekStart}.
          </CardDescription>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={running}
          className="shrink-0 rounded-card border border-border bg-brand-navy px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {running ? "Working…" : digest ? "Regenerate" : "Generate digest"}
        </button>
      </div>

      {error ? <p className="mt-3 text-sm text-state-danger">{error}</p> : null}

      {!digest ? (
        <p className="mt-3 text-sm text-text-muted">
          No digest generated for this week yet.
        </p>
      ) : digest.quietWeek ? (
        <p className="mt-3 text-sm text-text-muted">
          Quiet week — the checks found nothing unusual. No filler.
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {digest.bullets.map((b) => (
              <li key={b.findingKey} className="flex items-start gap-2 text-sm text-text">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    severityFor(digest, b.findingKey) === "red" ? "bg-state-danger" : "bg-state-warning"
                  }`}
                />
                <span>
                  {b.text}{" "}
                  <Link
                    href={b.href as Route}
                    className="font-medium text-brand-navy underline underline-offset-2"
                  >
                    View
                  </Link>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-text-muted">
            {digest.phrasing === "ai"
              ? `Worded by AI (${digest.model}) from the findings — validated so every number traces back.`
              : `Deterministic wording${digest.fallbackReason ? ` — AI phrasing unavailable: ${digest.fallbackReason}` : ""}.`}{" "}
            Generated {new Date(digest.generatedAt).toLocaleString()}.
          </p>
        </>
      )}

      {digest?.coverage ? (
        <p className="mt-2 border-t border-border pt-2 text-xs text-text-muted">
          Sees: {digest.coverage.sees.join("; ")}. Does not see:{" "}
          {digest.coverage.doesNotSee.join("; ")}.
        </p>
      ) : null}
    </Card>
  );
}
