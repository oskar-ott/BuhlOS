import type { Credential, CredentialStatus } from "./types";

/**
 * Training records with renewal reminders (#336) — pure projection, no I/O.
 *
 * The workforce store is KIND-DISCRIMINATED (workforce/credentials.json): v1
 * writes `kind: "licence"`; a training record is the same Credential shape with
 * `kind: "training"` (the schema comment anticipates exactly this). It reuses
 * the Credential fields: `label` = course, `issueDate` = completed, `expiryDate`
 * = the RENEWAL date, `notes`. Storing the renewal date in `expiryDate` means the
 * ONE compliance engine (api/_lib/licence-compliance.js `licenceStatusFor`) that
 * already powers register chips / the drawer / Phil self-view / the alert cron
 * computes a training record's renewal status with ZERO new code — this module
 * never recomputes expiry, it only PROJECTS the server-computed `status` /
 * `daysToExpiry` into renewal terms. No drift by construction.
 *
 * Deferred (touch hot/feature files): api/licences.js accepting `kind:"training"`
 * (+ a `provider` field) and the register / Phil renewal-reminder UI.
 */

export const TRAINING_KIND = "training";

/** A training record is a Credential with kind = "training". `provider`/
 *  `courseName` ride along via the schema's passthrough; `expiryDate` is the
 *  renewal date the shared engine computes status from. */
export type TrainingRecord = Credential & {
  provider?: string | null;
  courseName?: string | null;
};

export function isTrainingCredential(c: Pick<Credential, "kind">): boolean {
  return c.kind === TRAINING_KIND;
}

/** The training-kind subset of a mixed credentials list. */
export function trainingRecords(credentials: ReadonlyArray<Credential>): Credential[] {
  return credentials.filter(isTrainingCredential);
}

/** Renewal status re-presented from the server-computed credential status — the
 *  same engine output, in renewal language. NEVER recomputed here. */
export interface TrainingRenewal {
  status: CredentialStatus;
  daysToRenewal: number | null;
  band: TrainingReminderBand;
}

/** Reminder band for the UI: overdue (expired), due-soon (expiring), ok
 *  (current), none (no renewal date). */
export type TrainingReminderBand = "overdue" | "due-soon" | "ok" | "none";

export function renewalBandFor(status: CredentialStatus): TrainingReminderBand {
  switch (status) {
    case "expired":
      return "overdue";
    case "expiring":
      return "due-soon";
    case "current":
      return "ok";
    case "no-expiry":
      return "none";
  }
}

export function renewalOf(record: Pick<Credential, "status" | "daysToExpiry">): TrainingRenewal {
  return {
    status: record.status,
    daysToRenewal: record.daysToExpiry,
    band: renewalBandFor(record.status),
  };
}

/** Day-count renewal phrasing (no date formatting — foundation-scope). */
export function trainingRenewalLabel(record: Pick<Credential, "expiryDate" | "daysToExpiry">): string {
  if (!record.expiryDate || record.daysToExpiry === null) return "no renewal date";
  const d = record.daysToExpiry;
  if (d < 0) return `renewal overdue by ${Math.abs(d)} ${Math.abs(d) === 1 ? "day" : "days"}`;
  if (d === 0) return "renews today";
  return `renews in ${d} ${d === 1 ? "day" : "days"}`;
}

export interface TrainingSummary {
  total: number;
  /** current */
  ok: number;
  /** expiring */
  dueSoon: number;
  /** expired */
  overdue: number;
  /** no renewal date */
  noRenewal: number;
}

/** Roll up a set of training records by renewal band (the register strip). */
export function summariseTraining(records: ReadonlyArray<Credential>): TrainingSummary {
  const s: TrainingSummary = { total: records.length, ok: 0, dueSoon: 0, overdue: 0, noRenewal: 0 };
  for (const r of records) {
    switch (renewalBandFor(r.status)) {
      case "ok":
        s.ok += 1;
        break;
      case "due-soon":
        s.dueSoon += 1;
        break;
      case "overdue":
        s.overdue += 1;
        break;
      case "none":
        s.noRenewal += 1;
        break;
    }
  }
  return s;
}
