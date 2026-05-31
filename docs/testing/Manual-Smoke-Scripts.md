# Manual Smoke Scripts

## 5-minute admin smoke

1. Sign in at `/v2/login` as admin.
2. Confirm `/command-centre` shows BuhlOS branding, left navigation, and content.
3. Open `/v2/jobs`; confirm the list and literal-admin **New job** button.
4. Open one builder; confirm the BuhlOS shell remains present.
5. Check console for uncaught errors and network panel for persistent 5xx.

## 5-minute Phil smoke

1. Sign in at `/v2/login` as field worker.
2. Confirm `/phil/my-day`, `/phil/jobs`, `/phil/hours`, and `/phil/gear`.
3. Confirm Draft jobs are absent.
4. Open an active assigned job; confirm stages, areas, tasks, Hours, and Gear entry points.
5. Confirm admin save/publish controls are absent and `/v2/jobs/<id>/builder` redirects away.

## 10-minute job builder smoke

1. Create `SMOKE_TEST_<run-id>_Job_Builder` as Draft.
2. Add `Level 1`, `Unit 1`, rough-in `Rough-in power circuits`, and fit-off `Fit-off power points`.
3. Save and refresh; confirm persistence.
4. Confirm Phil preview uses saved data and shows the rough-in task.
5. Confirm publish checklist separates errors from warnings.
6. Publish, confirm field-visible state, then unpublish and confirm Draft.

## Plans Phase 1/2 smoke, when available

1. Register drawing metadata and upload a source PDF.
2. Add a newer revision and confirm exactly one current row.
3. Confirm Phil sees current revision only.
4. Open viewer and create note, pin, and line overlays.
5. Refresh and confirm overlays persist independently of the PDF.
6. Confirm stored coordinates remain in `0..1`.
7. Confirm hidden overlays stay hidden from Phil and visible overlays render read-only.
