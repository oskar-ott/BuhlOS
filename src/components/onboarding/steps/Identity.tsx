import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingHeading } from "../OnboardingHeading";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface IdentityStepProps {
  name: string | null;
  email: string | null;
  role: string | null;
  onContinue: () => void;
}

/**
 * Step 02 · Identity confirmation.
 *
 * Render whatever the session has (name, email, role). Anything we don't
 * have today — mobile, emergency contact, address — is shown with an
 * "Admin update" pill (design's `needsAdmin` variant). Per the design's
 * hard rule, missing data NEVER blocks the worker; the worker continues
 * either way and the office sorts it.
 *
 * This matches both design screens 02 (all clear) and 03 (needs admin
 * update) in one responsive composition: present fields render normally,
 * absent fields render with the amber pill.
 */
export function IdentityStep({ name, email, role, onContinue }: IdentityStepProps) {
  const initials = name
    ? name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("")
    : "??";

  const displayRole = role ? formatRole(role) : "BuhlOS field crew";

  const fields: ReadonlyArray<{ key: string; value: string | null }> = [
    { key: "Email", value: email },
    { key: "Mobile", value: null },
    { key: "Emergency", value: null },
    { key: "Address", value: null },
  ];

  const missingCount = fields.filter((f) => !f.value).length;

  return (
    <OnboardingShell>
      <OnboardingProgress step={2} total={TOTAL_STEPS} />
      <OnboardingHeading
        eyebrow="You"
        title="Is this you?"
        sub="Quick check. Anything missing? Office can fix it — keep going."
      />

      <div className="px-5 pt-2">
        <section
          aria-label="Your identity"
          className="overflow-hidden rounded-[14px] border border-border bg-surface"
        >
          <div className="flex items-center gap-3 px-4 pb-3 pt-4">
            <div
              className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-accent-yellow font-display text-lg font-extrabold tracking-tight text-brand-navy"
              aria-hidden="true"
            >
              {initials || "??"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-[19px] font-bold tracking-tight text-text">
                {name || "Your name"}
              </p>
              <p className="mt-1 truncate font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                {displayRole} · BuhlOS
              </p>
            </div>
          </div>

          {fields.map((f) => (
            <IdentityRow key={f.key} label={f.key} value={f.value} />
          ))}
        </section>

        {missingCount > 0 ? (
          <aside
            role="status"
            className="mt-3 flex items-start gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-3"
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-500 font-display text-sm font-extrabold text-white"
              aria-hidden="true"
            >
              !
            </span>
            <p className="text-[13px] leading-snug text-amber-900">
              <strong className="block text-text">
                {missingCount} field{missingCount === 1 ? "" : "s"} need
                {missingCount === 1 ? "s" : ""} admin
              </strong>
              The office can fill these in. You can keep going — they&rsquo;ll
              sort it out.
            </p>
          </aside>
        ) : null}
      </div>

      <OnboardingFooter
        primaryLabel={missingCount > 0 ? "Continue anyway" : "Yes, that's me"}
        onPrimary={onContinue}
      />
    </OnboardingShell>
  );
}

function IdentityRow({ label, value }: { label: string; value: string | null }) {
  const needsAdmin = !value;
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3 min-h-[56px]">
      <span className="w-20 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[14.5px] font-medium ${
          needsAdmin ? "text-text-muted" : "text-text"
        }`}
      >
        {value ?? "—"}
      </span>
      {needsAdmin ? (
        <span className="shrink-0 whitespace-nowrap rounded-[3px] bg-amber-100 px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-amber-800">
          Admin update
        </span>
      ) : (
        <span aria-hidden="true" className="text-lg text-text-muted">
          ›
        </span>
      )}
    </div>
  );
}

function formatRole(role: string): string {
  const r = role.toLowerCase();
  if (r === "tradie") return "Tradesman";
  if (r === "electrician") return "Electrician";
  if (r === "apprentice") return "Apprentice";
  if (r === "labourer") return "Labourer";
  if (r === "lh" || r.startsWith("leading")) return "Leading hand";
  return role.replace(/[_-]+/g, " ");
}
