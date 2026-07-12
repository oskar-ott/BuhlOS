-- #247 — integration_connections: provider-generic OAuth connection state.
-- Implements docs/architecture/integration-credential-storage-adr.md (#892):
--   * one row per (tenant, provider); first provider is 'xero'
--   * token columns hold AES-256-GCM CIPHERTEXT ONLY (api/_lib/secret-box.js
--     envelopes, key = XERO_TOKEN_ENC_KEY env) — never plaintext
--   * rotation concurrency via refresh_version optimistic CAS
--     (UPDATE ... WHERE id = $1 AND refresh_version = $2)
--   * RLS enabled with ZERO policies, permanently — no tier ever reads this
--     table through RLS; all access is service-role-mediated
--   * disconnect HARD-DELETES the row (dead ciphertext is a liability, not
--     history); the audit journal carries the evidence
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.integration_connections;

create table public.integration_connections (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id),
  provider                 text not null check (provider in ('xero')),

  -- The selected external organisation (Xero tenant). Null while the admin
  -- has authorised but not yet picked one of several organisations.
  external_tenant_id       text,
  external_tenant_name     text,

  -- secret-box envelopes ('v1.<iv>.<ct>.<tag>', base64url parts). NEVER
  -- plaintext; a CHECK enforces the envelope prefix so a plaintext token
  -- cannot be inserted even by a buggy caller.
  access_token_enc         text check (access_token_enc is null or access_token_enc like 'v1.%'),
  refresh_token_enc        text check (refresh_token_enc is null or refresh_token_enc like 'v1.%'),

  access_token_expires_at  timestamptz,
  granted_scopes           text,

  status                   text not null default 'pending_selection'
                           check (status in (
                             'pending_selection',
                             'connected',
                             'degraded',
                             'refresh_failed',
                             'reconnect_required'
                           )),
  last_error_category      text,

  -- Audit convenience (the durable trail lives in the audit journal).
  connected_by_legacy_id   text,
  connected_by_name        text,
  connected_at             timestamptz,

  last_success_at          timestamptz,
  last_refresh_attempt_at  timestamptz,
  last_refresh_success_at  timestamptz,

  -- Optimistic rotation lock: every token write bumps this via CAS.
  refresh_version          integer not null default 1,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (tenant_id, provider),
  unique (tenant_id, id)
);

comment on table public.integration_connections is
  '#247/#892: provider-generic OAuth connection state (first: Xero). Token columns are AES-256-GCM ciphertext envelopes only; rotation via refresh_version CAS; RLS zero-policy forever (service-role only); disconnect hard-deletes the row.';

create trigger integration_connections_touch
  before update on public.integration_connections
  for each row execute function public.tg_touch_updated_at();

-- RLS on, NO policies — deny-by-default for anon + authenticated, permanently
-- (stricter than the registries: no future read policy is ever planned; see
-- docs/architecture/supabase-rls-access-matrix.md).
alter table public.integration_connections enable row level security;
