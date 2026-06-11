-- ============================================================================
-- Phase 1 hardening — advisor cleanup
-- Drafted 2026-06-11 (docs/supabase-migration-research-audit.md §7);
-- APPLIED 2026-06-12 to project wetctlrhsycfwhuxlarv via MCP apply_migration
-- (name: phase1_hardening; remote version = this file's timestamp prefix).
--
-- Addresses live advisors:
--   * function_search_path_mutable (0011) on the two touch triggers
--   * anon/authenticated_security_definer_function_executable (0028/0029)
--     on the pre-existing rls_auto_enable()
-- ============================================================================

-- Both functions only touch NEW.* plus now()/coalesce (pg_catalog is always
-- searched implicitly), so an empty search_path cannot break them.
alter function public.tg_touch_updated_at() set search_path = '';
alter function public.tg_touch_updated_at_bump_revision() set search_path = '';

-- rls_auto_enable() is the pre-existing safety net (SECURITY DEFINER, fired by
-- event trigger ensure_rls; already pins search_path=pg_catalog). PostgREST
-- exposes it at /rest/v1/rpc/ to anon + authenticated; it fails harmlessly
-- outside event-trigger context, but there is no reason to leave it callable.
-- Conditional so this migration replays cleanly on local stacks where the
-- project-specific function does not exist.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
