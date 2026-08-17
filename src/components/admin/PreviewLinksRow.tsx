/**
 * Read-only export previews (owner redesign 2026-08-16) — the Review CSV /
 * Xero CSV / PDF links, shrunk from a whole card to one line. Every href
 * keeps the dryRun=1 invariant (#895 / payroll-boundary ADR #609): downloads
 * NEVER mark hours as exported, and the copy says so.
 *
 * Rendered inside the PayRunCard footer, and standalone (wrapped by the page)
 * when the batch flow isn't available — the downloads must survive every
 * flag/interim state.
 */

export function PreviewLinksRow({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const dryRunBase = `/api/time-entries-export?status=approved&fromDate=${fromDate}&toDate=${toDate}`;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="period-preview-links"
    >
      <span>Read-only previews:</span>
      <a
        href={`${dryRunBase}&shape=review&dryRun=1`}
        className="underline underline-offset-2 hover:text-text"
        data-testid="period-download-review"
      >
        Review CSV
      </a>
      <a
        href={`${dryRunBase}&shape=xero&dryRun=1`}
        className="underline underline-offset-2 hover:text-text"
        data-testid="period-download-xero"
      >
        Xero CSV
      </a>
      <a
        href={`${dryRunBase}&format=pdf&dryRun=1`}
        className="underline underline-offset-2 hover:text-text"
        data-testid="period-download-pdf"
      >
        PDF
      </a>
      <span>— they never mark hours exported.</span>
    </span>
  );
}
