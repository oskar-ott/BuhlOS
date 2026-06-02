# Plans Phase 1/2 pending smoke

The repo currently has a legacy `/admin/plans` upload/register API and a
modern read-only Phil documents list. It does not yet have the modern BuhlOS
plan register, PDF viewer, or overlay markup coordinate library required for
the requested Plans Phase 1/2 browser suite.

When those land, convert this note into `plans.spec.ts` and automate:

1. Register a drawing with drawing number, title, revision, and status.
2. Upload a new revision and assert exactly one current revision.
3. Open the BuhlOS viewer.
4. Create note, pin, and line overlays.
5. Refresh and assert overlay persistence.
6. Assert every stored coordinate is clamped to `0..1`.
7. Assert `visibleToPhil=false` stays hidden and `visibleToPhil=true` renders.
8. Assert Phil receives only the current revision and remains read-only.
