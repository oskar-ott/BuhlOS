"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Link2, Search } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { cn } from "@/lib/cn";
import { createEmployee, errorText } from "@/domains/employees/client";
import {
  ROLE_ORDER,
  ROLE_DEFS,
  appAccessFooter,
  isValidEmail,
  isValidAuMobile,
} from "@/domains/employees/service";
import type { EmployeeRole, EmployeeRow } from "@/domains/employees/types";

export interface ActiveJobOption {
  id: string;
  name: string;
  ref: string | null;
}

interface AddEmployeeDrawerProps {
  open: boolean;
  onClose: () => void;
  activeJobs: ReadonlyArray<ActiveJobOption>;
  emailConfigured: boolean;
  /** Called after a successful create. `inviteLink` is null for a saved draft. */
  onCreated: (row: EmployeeRow, inviteLink: string | null) => void;
}

const STEPS = ["Details", "Access", "Jobs / gear", "Invite"] as const;
const COMPANY = "bühl electrical";

export function AddEmployeeDrawer({
  open,
  onClose,
  activeJobs,
  emailConfigured,
  onCreated,
}: AddEmployeeDrawerProps) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<EmployeeRole | null>(null);
  const [apprenticeYear, setApprenticeYear] = useState<number | null>(null);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobSearch, setJobSearch] = useState("");
  const [notes, setNotes] = useState("");
  const [inviteNote, setInviteNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedLink, setIssuedLink] = useState<string | null>(null);
  const [issuedStatus, setIssuedStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setStep(0);
    setFirstName(""); setLastName(""); setDisplayName(""); setEmail(""); setPhone("");
    setRole(null); setApprenticeYear(null); setJobIds([]); setJobSearch("");
    setNotes(""); setInviteNote(""); setSubmitting(false); setError(null);
    setIssuedLink(null); setIssuedStatus(null); setCopied(false);
  }
  function close() { reset(); onClose(); }

  const phoneOk = phone.trim() === "" || isValidAuMobile(phone);
  const step1Valid =
    firstName.trim() !== "" && lastName.trim() !== "" && isValidEmail(email) && phoneOk;
  const step2Valid = role !== null && (role !== "apprentice" || apprenticeYear != null);

  const filteredJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) return activeJobs;
    return activeJobs.filter(
      (j) => j.name.toLowerCase().includes(q) || (j.ref ?? "").toLowerCase().includes(q)
    );
  }, [activeJobs, jobSearch]);

  async function submit(sendInvite: boolean) {
    if (!role) return;
    setSubmitting(true);
    setError(null);
    const res = await createEmployee({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      displayName: displayName.trim() || null,
      email: email.trim(),
      phone: phone.trim() || null,
      role,
      apprenticeYear: role === "apprentice" ? apprenticeYear : null,
      assignedJobIds: jobIds,
      notes: notes.trim() || null,
      sendInvite,
      inviteNote: inviteNote.trim() || null,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    const link = res.data.inviteLink
      ? toAbsolute(res.data.inviteLink)
      : null;
    onCreated(res.data.row, link);
    if (sendInvite && link) {
      // Keep the drawer open on the issued state so the admin can copy the link
      // (no fake email is sent when none is configured; on a send failure the
      // link is still a working fallback). issuedStatus drives the copy.
      setIssuedLink(link);
      setIssuedStatus(res.data.row.invite?.status ?? "sent");
    } else {
      close();
    }
  }

  async function copyLink() {
    if (!issuedLink) return;
    try {
      await navigator.clipboard.writeText(issuedLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const headerName = firstName || lastName ? `${firstName} ${lastName}`.trim() : "Add employee";
  const subtitle = issuedLink
    ? "invite ready"
    : `step ${step + 1} of 4 · ${STEPS[step]!.toLowerCase()}`;

  return (
    <Drawer
      open={open}
      onClose={close}
      title={headerName}
      subtitle={subtitle}
      footer={!issuedLink ? renderFooter() : (
        <div className="flex justify-end">
          <Button onClick={close}>Done</Button>
        </div>
      )}
    >
      {issuedLink ? renderIssued() : (
        <>
          <StepIndicator step={step} />
          {error ? (
            <p className="mb-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </p>
          ) : null}
          {step === 0 ? renderDetails() : null}
          {step === 1 ? renderAccess() : null}
          {step === 2 ? renderJobsGear() : null}
          {step === 3 ? renderInvite() : null}
        </>
      )}
    </Drawer>
  );

  function renderFooter() {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          {step > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setStep((s) => s - 1)}>
              ← Back
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
          )}
        </div>
        {step < 3 ? (
          <Button
            size="sm"
            disabled={(step === 0 && !step1Valid) || (step === 1 && !step2Valid)}
            onClick={() => setStep((s) => s + 1)}
          >
            Next · {STEPS[step + 1]} →
          </Button>
        ) : null}
      </div>
    );
  }

  function renderDetails() {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" required>
            <input className={inputClass} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </Field>
          <Field label="Last name" required>
            <input className={inputClass} value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <Field label="Email" required help="Invite will be sent here.">
          <input
            type="email"
            className={cn(inputClass, email !== "" && !isValidEmail(email) && "border-rose-400")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="liam.m@gmail.com"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mobile" help={phone && !phoneOk ? "AU mobile, e.g. 0421 558 902" : "Optional"} error={Boolean(phone) && !phoneOk}>
            <input
              className={cn(inputClass, phone !== "" && !phoneOk && "border-rose-400")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+61 421 558 902"
            />
          </Field>
          <Field label="Display name" help="Nickname (optional)">
            <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Lemo" />
          </Field>
        </div>
        <Field label="Notes (admin only)" help="Not shown to the worker.">
          <textarea className={cn(inputClass, "h-16 resize-none")} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. nephew of Mick · TAFE Wed AM" />
        </Field>
      </div>
    );
  }

  function renderAccess() {
    return (
      <div className="space-y-3">
        <p className="text-sm text-text-muted">
          Role decides which app they get. Pick one — granular permissions come later.
        </p>
        <div className="grid grid-cols-1 gap-2">
          {ROLE_ORDER.map((id) => {
            const def = ROLE_DEFS[id];
            const selected = role === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => { setRole(id); if (id !== "apprentice") setApprenticeYear(null); }}
                className={cn(
                  "rounded-card border p-3 text-left transition-colors",
                  selected ? "border-brand-navy bg-surface-subtle" : "border-border hover:bg-surface-subtle"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-sm text-text">{def.title}</span>
                  <span className="flex items-center gap-1.5">
                    {def.uc ? <StatusChip tone="yellow">UC</StatusChip> : null}
                    <StatusChip tone={def.surfaceChip === "phil" ? "yellow" : def.surfaceChip === "both" ? "navy" : "neutral"}>
                      {def.surfaceChip === "phil" ? "Phil" : def.surfaceChip === "both" ? "Phil + review" : "BuhlOS"}
                    </StatusChip>
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-muted">{def.description}</p>
              </button>
            );
          })}
        </div>
        {role === "apprentice" ? (
          <Field label="Apprentice year" required>
            <div className="flex gap-2">
              {[1, 2, 3, 4].map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => setApprenticeYear(y)}
                  className={cn(
                    "h-9 w-12 rounded-card border text-sm",
                    apprenticeYear === y ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border"
                  )}
                >
                  Y{y}
                </button>
              ))}
            </div>
          </Field>
        ) : null}
        {role ? (
          <p className="rounded-card bg-surface-subtle px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
            {appAccessFooter(role)}
          </p>
        ) : null}
      </div>
    );
  }

  function renderJobsGear() {
    return (
      <div className="space-y-4">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
              Assigned jobs
            </span>
            {jobIds.length > 0 ? <StatusChip tone="yellow">{jobIds.length}</StatusChip> : null}
          </div>
          <div className="mb-2 flex items-center gap-2 rounded-card border border-border px-2">
            <Search aria-hidden="true" className="h-4 w-4 text-text-muted" />
            <input
              className="h-9 flex-1 bg-transparent text-sm outline-none"
              placeholder="Search jobs…"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
            />
          </div>
          {activeJobs.length === 0 ? (
            <p className="text-xs text-text-muted">No active jobs to assign. You can assign jobs later from the worker&rsquo;s record.</p>
          ) : (
            <ul className="max-h-44 space-y-1 overflow-y-auto">
              {filteredJobs.map((j) => {
                const on = jobIds.includes(j.id);
                return (
                  <li key={j.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setJobIds((ids) => (on ? ids.filter((x) => x !== j.id) : [...ids, j.id]))
                      }
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-card border px-3 py-2 text-left text-sm",
                        on ? "border-brand-navy bg-surface-subtle" : "border-border hover:bg-surface-subtle"
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {j.ref ? <span className="font-mono text-xs text-text-muted">{j.ref} · </span> : null}
                        {j.name}
                      </span>
                      {on ? <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-navy" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-1 text-xs text-text-muted">Skip is fine — assign later from the worker&rsquo;s record.</p>
        </div>

        <UnderConstructionPanel
          feature="Gear · vehicles · licences · inductions"
          description="Gear is assigned once the worker has set up Phil (so it links to their account); vehicle, licence and induction registers don't exist yet. These land in O4."
        />
      </div>
    );
  }

  function renderInvite() {
    const greeting = `G'day ${firstName || "there"},`;
    return (
      <div className="space-y-3">
        <PreviewRow label="To" value={email} />
        <PreviewRow label="Subject" value={emailConfigured ? `You're invited to Phil — ${COMPANY}` : "Phil invite link"} />
        <PreviewRow label="Greeting" value={greeting} />
        <Field label={`Optional note from you`} help="One personal line, shown in the invite.">
          <input className={inputClass} value={inviteNote} onChange={(e) => setInviteNote(e.target.value)} placeholder="Welcome aboard mate — see you Monday at Magill Rd…" />
        </Field>
        <PreviewRow label="Expires" value="14 days after creating" />

        {!emailConfigured ? (
          <p className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Phil setup is not live on main yet, so this screen creates the invite link
            without emailing it to the worker. Keep the link internal until O3 is merged.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" disabled={submitting} onClick={() => submit(true)}>
            {emailConfigured ? "Send invite →" : "Create invite link →"}
          </Button>
          <Button variant="secondary" size="sm" disabled={submitting} onClick={() => submit(false)}>
            Save without sending
          </Button>
        </div>
      </div>
    );
  }

  function renderIssued() {
    const failed = issuedStatus === "failed";
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusChip tone={failed ? "danger" : "warning"}>{failed ? "Failed" : "Invited"}</StatusChip>
          <span className="text-sm text-text-muted">{email}</span>
        </div>
        {failed ? (
          <p className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            We couldn&rsquo;t send the invite email. Copy the link below and send it to the worker
            yourself — the link still works.
          </p>
        ) : (
          <p className="text-sm text-text">
            {emailConfigured
              ? "Invite sent. The worker can also use this link directly:"
              : "Invite link created. Phil setup is not live on main yet, so keep this link internal until O3 is merged:"}
          </p>
        )}
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={issuedLink ?? ""}
            className={cn(inputClass, "flex-1 font-mono text-xs")}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button size="sm" variant="secondary" onClick={copyLink}>
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
          Single-use · expires in 14 days. Worker setup lands in O3.
        </p>
      </div>
    );
  }
}

/* ---- small building blocks ---- */

const inputClass =
  "w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-border-strong";

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="mb-4 grid grid-cols-4 overflow-hidden rounded-card border border-border">
      {STEPS.map((label, i) => {
        const done = i < step;
        const now = i === step;
        return (
          <div
            key={label}
            className={cn(
              "border-r border-border px-2 py-2 last:border-r-0",
              now && "bg-brand-navy text-text-inverse",
              done && "bg-surface-subtle"
            )}
          >
            <div className={cn("font-mono text-[9.5px] uppercase tracking-wider", now ? "text-accent-yellow" : done ? "text-emerald-600" : "text-text-muted")}>
              {done ? "✓ " : ""}{String(i + 1).padStart(2, "0")}
            </div>
            <div className={cn("truncate font-display text-xs", now ? "text-text-inverse" : done ? "text-text" : "text-text-muted")}>
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  required,
  help,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      {children}
      {help ? (
        <span className={cn("mt-1 block text-[11px]", error ? "text-rose-600" : "text-text-muted")}>{help}</span>
      ) : null}
    </label>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 break-words text-sm text-text">{value}</div>
    </div>
  );
}

function toAbsolute(relative: string): string {
  if (typeof window === "undefined") return relative;
  if (/^https?:\/\//.test(relative)) return relative;
  return `${window.location.origin}${relative}`;
}
