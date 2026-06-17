# Task blockers and readiness

This is a read-only domain model (`src/domains/jobs/task-blockers.ts`).

It does not persist blockers yet, and it does not derive them from real
variations / observations / material-requests yet — it defines the shape and the
pure readiness rules only.

It exists so future admin/Phil views can explain why a task is not ready.

Tasks remain identified by canonical task ids (`CanonicalTask.id`, derived from
`jobId + areaId + stage + taskId`), so dependencies can cross areas — e.g. one
area's fit-off waiting on another area's rough-in is just two canonical ids.

Readiness is conservative and ordered: a complete task is `complete`; an open
blocker or an incomplete/missing dependency is `blocked`; otherwise `ready`.
