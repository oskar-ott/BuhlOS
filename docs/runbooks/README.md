# Operational runbooks (2026-09)

Step lists for the things a person has to do that the code cannot do for
them. Each runbook ends with a **stamp table**: who did the step, when, and
what they saw. A step without a stamp has not happened — the same discipline
as the five flag states in [../feature-flags.md](../feature-flags.md) ("What a
flag proves"): *built* is proven by the repo, *registry default* by CI,
*effectively enabled* by `/owner`, *externally configured* and *operationally
proven* only by a dated, signed stamp here or in the feature's own doc.

| Runbook | Use it when |
| --- | --- |
| [Production effective-flag verification](production-flag-verification.md) | Anyone needs to say what is actually on in production. |
| [Invoice mailbox activation](invoice-mailbox-activation.md) | Turning supplier-invoice email intake on for the first time. |
| [Supplier pilot](supplier-pilot-checklist.md) | Proving invoice capture on one real supplier before the next. |
| [Automatic-booking shadow review](auto-booking-shadow-review.md) | The weekly read of the shadow report, and the decision it feeds. |
| [Real-Xero proving](real-xero-proving.md) | Connecting the real Xero organisation and proving one payroll export. |
| [Rollback and incident steps](rollback-and-incident.md) | Something is wrong in production and must stop or be undone. |
| [Document-retention decision record](document-retention-decision-record.md) | Deciding how long invoice PDFs, photos and history are kept. |

Rules that apply to every runbook:

- **No step here changes production by itself.** Flags flip at `/owner`, env
  in the Vercel dashboard, mail rules in the mailbox, Xero in Xero. Runbooks
  say what to do and what to check; the person doing it signs the stamp.
- **Read before write.** Every runbook starts with a verification step; do not
  skip it because the outcome "should" be known.
- **Nothing is proven by CI except the code.** Green CI on `main` says the
  code is built and tested; it says nothing about mailboxes, DNS, secrets,
  Xero or real users.
