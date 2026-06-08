/**
 * Phil — "Not connected in Phil yet" note.
 *
 * One compact, low-emphasis, honest line that replaces the two full-card
 * under-construction panels (Materials + History) that used to sit at the
 * bottom of the job screen. Those were placeholder sections dominating the
 * scroll with "Under construction" cards for features that aren't wired.
 *
 * This keeps the worker honestly informed — Materials and Job history aren't in
 * Phil yet, and what to do instead (phone the PM for materials) — without two
 * big cards pretending to be sections. When either ships for real, it returns
 * as its own genuine section, not a stub.
 *
 * Pure + render-friendly (no props, no state) so it server-renders and
 * unit-tests with `renderToString`.
 */
export function PhilJobDeferredNote() {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface-subtle px-4 py-3">
      <p className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Not connected in Phil yet
      </p>
      <p className="mt-1 text-sm text-text-muted">
        <span className="font-medium text-text">Materials</span> — phone or text
        your PM to order anything for site.{" "}
        <span className="font-medium text-text">Job history</span> — the full
        activity log lives in the office for now.
      </p>
    </div>
  );
}
