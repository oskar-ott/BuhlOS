# Audit Log Durability Design Pack

## What this is

This directory is a docs-only design pack for the future Audit Log Durability / Mutation Guarantee work.

It defines:

- Which mutations should require audit logging.
- Which audit failures should block the mutation.
- Which audit failures may remain best-effort.
- What the AuditLog schema should guarantee.
- How implementation should be phased safely.
- What tests are required before code changes.

## What this is not

This is not an implementation PR.

It does not:

- Change app code.
- Change APIs.
- Change tests.
- Change workflows.
- Change Preview Smoke.
- Change route or shell guards.
- Change Phil hours behavior.
- Change Gear behavior.
- Change production data.
- Claim audit durability is currently enforced.

## Current status

PLANNED / NOT IMPLEMENTED

Current audit-log behavior remains whatever the application code implements today. The documents here are the target policy for future PRs.

## Documents

- [Audit Log Durability Spec](AUDIT_LOG_DURABILITY_SPEC.md)
- [Mutation Policy Matrix](MUTATION_POLICY_MATRIX.md)
- [Implementation Plan](IMPLEMENTATION_PLAN.md)

## Next recommended PR

Create a small helper-hardening PR first:

- Add explicit blocking vs best-effort audit modes.
- Add sanitization helpers.
- Add typed action/domain constants.
- Add request/correlation id support.
- Add tests for audit append failure behavior before migrating mutation routes.

