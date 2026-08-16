import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * normalizeRecipients — the pure gate on the send-to-accounts recipient list
 * (api/_lib/timesheet-email-settings.js). The list is the SWITCH for the
 * interim email export, so the rules matter: a malformed address is a NAMED
 * refusal (payroll data must never quietly miss an inbox someone thinks they
 * added), blanks drop silently, everything is trimmed/lowercased/deduped, and
 * the list is capped.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeRecipients, MAX_RECIPIENTS } = requireFromHere(
  "../../../api/_lib/timesheet-email-settings.js"
);

describe("normalizeRecipients", () => {
  it("trims, lowercases and dedupes", () => {
    expect(
      normalizeRecipients([" Tia@Example.com ", "tia@example.com", "Backup@Example.com"])
    ).toEqual({ ok: true, recipients: ["tia@example.com", "backup@example.com"] });
  });

  it("drops blank entries silently (a blank add-box submit is not an error)", () => {
    expect(normalizeRecipients(["", "  ", "tia@example.com", null])).toEqual({
      ok: true,
      recipients: ["tia@example.com"],
    });
  });

  it("refuses a malformed address BY NAME", () => {
    const bad = ["no-at-sign.example.com", "two words@example.com", "trailing@nodot"];
    for (const email of bad) {
      const res = normalizeRecipients(["tia@example.com", email]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(email.trim().toLowerCase());
    }
  });

  it("refuses a non-array", () => {
    for (const input of ["tia@example.com", null, undefined, { recipients: [] }]) {
      expect(normalizeRecipients(input).ok).toBe(false);
    }
  });

  it("an empty list is VALID — it is how the process switches off", () => {
    expect(normalizeRecipients([])).toEqual({ ok: true, recipients: [] });
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `person${i}@example.com`);
    expect(normalizeRecipients(many).ok).toBe(false);
    expect(normalizeRecipients(many.slice(0, MAX_RECIPIENTS)).ok).toBe(true);
  });
});
