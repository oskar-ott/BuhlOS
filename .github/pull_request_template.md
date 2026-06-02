## Summary

## Required checks

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test:unit`
- [ ] `npm run build`
- [ ] No credentials committed

## Auth and routing

- [ ] Unauthenticated users redirect to login
- [ ] Admin reaches BuhlOS
- [ ] Field user reaches Phil, if applicable
- [ ] Field user is blocked from admin builder/editor

## Job builder

- [ ] Draft can be created
- [ ] Structure saves and persists after refresh
- [ ] Phil preview uses saved data
- [ ] Publish and unpublish work
- [ ] Smoke job returned to Draft

## Phil

- [ ] Active jobs visible
- [ ] Draft jobs hidden
- [ ] Admin-only controls hidden

## Plans, if touched

- [ ] Source PDFs remain immutable
- [ ] Overlays remain separate from PDFs
- [ ] Coordinates remain normalised `0..1`
- [ ] Current and superseded revisions tested
- [ ] Phil current-only visibility tested

## Manual smoke

- [ ] Claude smoke completed for high-risk changes
- [ ] Bugs fixed or documented
- [ ] Test data cleaned up or parked as Draft
