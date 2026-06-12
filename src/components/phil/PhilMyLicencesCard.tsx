import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  credentialStatusLabel,
  credentialToneFor,
  expiryLabel,
  sortCredentials,
} from "@/domains/workforce/service";
import type { Credential } from "@/domains/workforce/types";

/**
 * "My licences & tickets" on the Phil More tab (#331). Read-only — the
 * office maintains the register; the worker sees their OWN records and
 * statuses (the licence-expiry push deep-links here). Renders nothing
 * worth hiding: no other worker's data ever reaches this card.
 */

interface PhilMyLicencesCardProps {
  credentials: ReadonlyArray<Credential>;
  fetchError: string | null;
}

export function PhilMyLicencesCard({ credentials, fetchError }: PhilMyLicencesCardProps) {
  const sorted = sortCredentials(credentials);
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>My licences &amp; tickets</CardTitle>
        <CardDescription>
          What the office has on file for you. Spot something wrong or
          renewed? Tell the office — they update the register.
        </CardDescription>
      </div>

      {fetchError ? (
        <p className="text-sm text-text-muted">
          Couldn&rsquo;t load your licences right now ({fetchError}). Pull to
          refresh or try again later.
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-text-muted">
          None on file yet. The office records these — once they do,
          you&rsquo;ll see renewal warnings here before anything expires.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">{c.label}</span>
                <span className="block text-xs text-text-muted">{expiryLabel(c)}</span>
              </span>
              <Pill tone={credentialToneFor(c.status)}>{credentialStatusLabel(c.status)}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
