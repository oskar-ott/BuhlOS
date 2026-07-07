-- #882 — takeoff counts from the legend schedule's quantities.
-- Widens takeoff_lines.source_type to admit 'legend-qty': a line whose count
-- comes from the legend schedule's own tabulated quantity (e.g. "49 EA"),
-- accepted by a human on the legend entry. Detection is demoted to
-- locator/spot-check for these labels and never overrides them.
--
-- Additive only: existing rows and the four existing source types are
-- untouched; the default-named inline check constraint is re-created with the
-- one extra value.

alter table public.takeoff_lines
  drop constraint takeoff_lines_source_type_check;

alter table public.takeoff_lines
  add constraint takeoff_lines_source_type_check
  check (source_type in ('device-count', 'schedule-row', 'cable-estimate', 'manual', 'legend-qty'));
