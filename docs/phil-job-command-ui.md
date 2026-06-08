# Phil job command UI (`feat/phil-job-command-ui`)

Wires the **Phil Job Command Model** (#96) into the Phil job page as a compact,
mobile-first **"Next on this job"** section. This is the UI half of #96, which
shipped the pure decision layer model-only (it couldn't touch the job page
because #94 owned it at the time). #94 has since merged, so this slice safely
adds the UI.

It is **not** a hardcoded action hub: the panel renders **entirely from the
model**. It never inspects raw job / evidence / hours / task data.

## What shipped

- **`src/components/phil/PhilJobCommandPanel.tsx`** — a pure, render-friendly
  component that takes a `PhilJobCommandModel` and renders:
  - the single `primaryAction` as the prominent CTA (navy-filled — yellow stays
    reserved for the one Capture CTA per screen, per `PhilActionButton`);
  - the ranked secondary `actions` as compact rows;
  - a hard-blocker notice (on hold) — and **no** primary, so a worker is never
    led into work on a blocked job;
  - honest `limitations` as muted one-liners.
  - Actions the model leaves `href`-less are in-page jumps; the panel maps them
    to the job page's section anchors (`#phil-job-capture`, `#phil-job-itps`,
    `#phil-job-work`, `#phil-job-plans`, `#phil-job-snags`). Cross-surface
    actions (hours → `/phil/my-day`, rejected hours → `/phil/hours`) use their
    own `href`.

- **`src/components/phil/PhilJobDetail.tsx`** — builds the model from data the
  page already loads (no new fetch) and renders the panel right after the hero:

  ```tsx
  const commandModel = useMemo(
    () => buildPhilJobCommandModel(philJobCommandInputFromJobData({
      job, snags, itps, documents,
      taskState: taskStateError ? undefined : taskState,
      loadErrors: { documents: documentsError != null },
    })),
    [...],
  );
  // ...
  <PhilJobHero job={job} />
  <PhilJobCommandPanel model={commandModel} />
  <PhilJobAttentionStrip ... />
  ```

## Two deliberate decisions

1. **The panel replaces the flat `PhilJobSectionAnchors` strip** (deleted). The
   anchors were a flat row of jump-chips to the same sections the panel's
   actions now target — prioritised, with a primary CTA. Keeping both would
   duplicate "Capture / Snags / ITPs / …" above the fold (exactly the clutter
   #96 exists to retire). The minor losses (a "Site" jump; a "Materials"
   jump-chip) are negligible: Site is one short scroll down, and Materials is a
   panel limitation.

2. **The panel does NOT render the model's info/warning `attention`.** The job
   page already has `PhilJobAttentionStrip` directly below — richer,
   *viewer-scoped* ("assigned to me", "rejected snags") in a way the job-wide
   model attention is not. Re-rendering attention in the panel would duplicate
   it. The panel surfaces only the hard `blocked` attention (on hold), which the
   strip doesn't cover. Every other attention signal still reaches the worker —
   via the strip, or as a panel action (e.g. `fix_rejected_hours`,
   `complete_checks`).

## Honesty (inherited from the model, preserved by the panel)

- Rejected hours isn't fetched on the job page → the model returns an honest
  limitation ("Rejected hours aren't shown on the job screen — check your Hours
  tab"), never a fake card. When a caller later passes `rejectedHoursForJob`,
  the `fix_rejected_hours` action lights up with no panel change.
- Task completion shows as `tracked` only when real task state loaded cleanly;
  on an errored load the page passes `undefined`, so tasks stay `list_only`
  ("View your tasks") — never a fabricated completion count. After a confirmed
  task toggle, the panel updates from the same live task state as the task rows.
- No admin / payroll / Xero / dashboard language; no fake completed / uploaded /
  signed-off copy (asserted in tests).

## What was deferred

- Per-job **rejected-hours** wiring (the upgrade hook). The job page doesn't
  fetch time entries; fetching + filtering by `allocations[].jobId` is its own
  slice. Until then it's an honest limitation.
- No change to hours/capture/task **write** paths — the panel is read-only
  navigation into existing surfaces.

## Tests

`PhilJobCommandPanel.render.test.tsx` (10): primary/secondary rendering, in-page
anchor vs cross-surface href mapping, limitations, hard-blocker (no primary),
**no** info/warning attention (de-dup guard), honest empty + null-render, no
admin/payroll/Xero/dashboard language, no fake completion/upload/sign-off copy,
and three **bridge → model → panel** end-to-end cases (released job, tracked
task state, office-only draft). The #96 model/bridge keep their own 37 tests.

Validation: `typecheck`, `lint`, `test:unit` (1475), `test:api` (209), `build`,
`check:smoke-list` (11), route/shell guards — all green. Preview Smoke **not**
dispatched.
