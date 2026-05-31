# Claude Authenticated Preview Smoke

## Inputs Claude needs

- Vercel preview URL
- Admin credentials, supplied out-of-band
- Field credentials if available, supplied out-of-band
- Branch and pull request

## Rules

- Never commit credentials or paste them into issues, PRs, chat, logs, or screenshots.
- Prefix generated jobs with `SMOKE_TEST_`.
- Never leave a generated job Active. Park it as Draft before reporting.
- Take screenshots of login success, saved builder state, Phil preview,
  published state, and final Draft state.
- Inspect browser console and failed / 5xx network requests.
- Fix bugs found in the branch, add regression tests, and rerun checks.
- Warn explicitly if preview and production appear to share Blob storage.

## Live browser script

1. Open the preview URL and sign in through `/v2/login` as admin.
2. Confirm `/command-centre` renders BuhlOS branding, the left navigation,
   visible queue content or honest error cards, and no blank shell.
3. Open `/v2/jobs`; confirm the jobs list and literal-admin **New job** action.
4. Create `SMOKE_TEST_<run-id>_Job_Builder` as Draft.
5. In **Structure**, add group `Level 1`, area `Unit 1`, rough-in task
   `Rough-in power circuits`, and fit-off task `Fit-off power points`.
6. Confirm dirty state, save, observe saving, and confirm **All changes saved**.
7. Refresh. Confirm group, area, and tasks persisted.
8. Open **Phil preview**. Confirm it states that it is derived from saved
   structure and not mock data. Confirm the rough-in task appears.
9. Open **Publish**. Confirm blockers and advisory warnings are distinct.
10. Publish Draft → Active. Screenshot the field-visible state.
11. Immediately unpublish Active → Draft. Confirm office-only state and
    screenshot the parked Draft.
12. If field credentials exist, sign in as field. Confirm Phil shell, Jobs,
    active assigned jobs, hidden Draft jobs, job stages / areas / tasks, and
    Hours / Gear entry points. Confirm no admin save or publish controls.
13. As field, attempt an admin builder URL. Confirm redirect away.
14. As admin, attempt a Phil URL. Confirm redirect away under the current role policy.
15. If Plans is touched, run current/superseded and current-only Phil checks.
    Run overlay and coordinate checks only when that modern module exists.
16. Review screenshots, console errors, network failures, and cleanup state.

## Bug report format

```markdown
### <title>

- Severity:
- Route:
- Role:
- Steps:
- Expected:
- Actual:
- Screenshots:
- Console / network:
- Suspected file:
- Fix:
- Retest:
```

## Final report format

```markdown
## Preview smoke report

| Check | Pass / fail / skipped | Notes |
| ----- | --------------------- | ----- |

### Bugs found

### Bugs fixed

### Bugs open

### Commands run

### Cleanup state

### Merge recommendation
```
