-- #249 proving-run fix: the timesheet-events journal writes a durable
-- 'pending' event BEFORE the Xero POST (deliberate crash-safety: a crash
-- after the POST is reconcilable from the journal), but attempt_id carried a
-- foreign key to payroll_batch_timesheet_attempts — whose row is only
-- inserted AFTER the POST concludes with an outcome. The constraint inverted
-- the designed write order and failed every export at the first pending
-- event (found live on the first real export; service tests run on a fake
-- sql handle and cannot see FK enforcement).
--
-- The journal is append-only and attempt_id is a CORRELATION id, not a
-- referential guarantee — drop the FK, keep the index. Additive-safe:
-- no data change; the down path (documented, not executed) is
--   alter table public.payroll_batch_timesheet_events
--     add constraint payroll_batch_timesheet_events_attempt_id_fkey
--     foreign key (attempt_id) references public.payroll_batch_timesheet_attempts(id) on delete cascade;

alter table public.payroll_batch_timesheet_events
  drop constraint payroll_batch_timesheet_events_attempt_id_fkey;
