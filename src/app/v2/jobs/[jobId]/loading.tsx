import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardKicker } from "@/components/ui/Card";

/**
 * Instant hub skeleton (Job Detail Variants 2c) while the blocking job fetch
 * runs — the same frame the loaded page uses (hero card, full-width Money,
 * doing/knowing grid), with `.sk` shimmer blocks holding each value's final
 * footprint so nothing jumps when the render lands. Decorative only; the
 * region carries the screen-reader label.
 */
export default function Loading() {
  return (
    <AdminShell title="Job" hideHead>
      <div className="mx-auto w-full max-w-[1200px]" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading job…</span>
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted underline decoration-accent-yellow decoration-2 underline-offset-4">
          ← Jobs
        </p>

        {/* Hero */}
        <Card className="mt-3 overflow-hidden p-0">
          <div className="p-4 sm:p-7 sm:pb-6" aria-hidden="true">
            <div className="flex items-start justify-between gap-4">
              <div className="sk h-3.5 w-64 max-w-[60%]" />
              <div className="sk h-6 w-20 rounded-pill" />
            </div>
            <div className="sk mt-3 h-9 w-96 max-w-[85%]" />
            <div className="sk mt-3 h-4 w-72 max-w-[70%]" />
            <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
              <div className="flex items-center gap-3">
                <div className="sk h-10 w-32 rounded-[6px]" />
                <div className="sk h-9 w-40 rounded-[6px]" />
              </div>
              <div className="flex items-start gap-8">
                <div className="sk h-10 w-14" />
                <div className="sk h-10 w-24" />
                <div className="sk h-10 w-16" />
              </div>
            </div>
          </div>
          <div aria-hidden="true" className="h-1 w-full bg-accent-yellow" />
        </Card>

        {/* Money */}
        <Card className="mt-5 p-0">
          <div className="flex items-baseline justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
            <CardKicker>Money</CardKicker>
            <div className="sk h-3.5 w-56 max-w-[40%]" aria-hidden="true" />
          </div>
          <div className="mt-4 grid grid-cols-2 border-t border-border sm:grid-cols-4" aria-hidden="true">
            {["w-28", "w-24", "w-24", "w-20"].map((w, i) => (
              <div key={w + i} className="px-4 py-3 sm:px-6 sm:py-4">
                <div className="sk h-3 w-16" />
                <div className={`sk mt-2 h-[26px] ${w}`} />
              </div>
            ))}
          </div>
          <div className="border-t border-border px-4 py-4 sm:px-6" aria-hidden="true">
            <div className="grid gap-2.5">
              <div className="sk h-4 w-full" />
              <div className="sk h-4 w-full" />
              <div className="sk h-4 w-[72%]" />
            </div>
          </div>
        </Card>

        {/* Doing left, knowing right */}
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]" aria-hidden="true">
          <div className="grid gap-5">
            <Card>
              <CardKicker>Labour</CardKicker>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="sk h-16 rounded-[4px]" />
                <div className="sk h-16 rounded-[4px]" />
              </div>
              <div className="sk mt-4 h-6 w-3/4 rounded-[4px]" />
            </Card>
            <Card>
              <CardKicker>Evidence</CardKicker>
              <div className="mt-4 grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className={i >= 4 ? "sk hidden aspect-square sm:block" : "sk aspect-square"}
                  />
                ))}
              </div>
              <div className="sk mt-3.5 h-4 w-64 max-w-full" />
            </Card>
          </div>
          <div className="grid gap-5">
            <Card>
              <CardKicker>Build &amp; publish</CardKicker>
              <div className="sk mt-3 h-4 w-56 max-w-full" />
              <div className="mt-4 flex items-center gap-2">
                <div className="sk h-9 w-32 rounded-[4px]" />
                <div className="sk h-9 w-28 rounded-[4px]" />
              </div>
            </Card>
            <Card>
              <CardKicker>Site</CardKicker>
              <div className="mt-4 grid gap-4">
                <div className="sk h-9 w-full" />
                <div className="sk h-9 w-4/5" />
              </div>
            </Card>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
