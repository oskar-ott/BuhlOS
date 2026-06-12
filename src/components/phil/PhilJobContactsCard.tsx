import { Card, CardTitle } from "@/components/ui/Card";
import type { JobContact } from "@/domains/contacts/schema";

/**
 * Job contacts in Phil (#189) — the first job-bible section in the field.
 * Categorised contacts only (project people first, then suppliers); the
 * legacy uncategorised email-list rows that feed the snag-email picker
 * stay invisible. Tap-to-call / tap-to-SMS via tel:/sms: links — the
 * whole point is "ring the site super without ringing the office".
 *
 * Render nothing when the job has no categorised contacts — an empty
 * contacts card is noise, not honesty.
 */

interface Props {
  contacts: ReadonlyArray<JobContact>;
}

function clean(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

export function PhilJobContactsCard({ contacts }: Props) {
  const categorised = contacts.filter(
    (c) => c.category === "project" || c.category === "supplier",
  );
  if (categorised.length === 0) return null;
  const project = categorised.filter((c) => c.category === "project");
  const suppliers = categorised.filter((c) => c.category === "supplier");

  return (
    <Card>
      <CardTitle>Who to call</CardTitle>

      {[
        { label: null, rows: project },
        { label: "Suppliers", rows: suppliers },
      ].map(({ label, rows }) =>
        rows.length === 0 ? null : (
          <div key={label ?? "project"} className="mt-3">
            {label ? (
              <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {label}
              </h3>
            ) : null}
            <ul className="divide-y divide-border">
              {rows.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{c.name ?? "—"}</p>
                    <p className="text-xs text-text-muted">
                      {[c.role, c.description].filter(Boolean).join(" · ") || " "}
                    </p>
                    {c.email ? <p className="text-xs text-text-muted">{c.email}</p> : null}
                  </div>
                  {c.phone ? (
                    <div className="flex shrink-0 gap-2">
                      <a
                        href={`tel:${clean(c.phone)}`}
                        className="inline-flex min-h-[48px] items-center rounded-card bg-brand-navy px-4 text-sm font-medium text-white"
                        data-testid="contact-call"
                      >
                        Call
                      </a>
                      <a
                        href={`sms:${clean(c.phone)}`}
                        className="inline-flex min-h-[48px] items-center rounded-card border border-border px-4 text-sm font-medium text-text"
                        data-testid="contact-sms"
                      >
                        Text
                      </a>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </Card>
  );
}
