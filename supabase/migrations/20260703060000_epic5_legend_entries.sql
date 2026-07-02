-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#201): per-project symbol legend vocabulary
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE except one CHECK widening (see below).
--
-- The legend sheet is the project's symbol vocabulary — every consultant
-- redefines the symbols, so device recognition (#204/#205) must speak THIS
-- job's language, not a generic one. This migration adds:
--
--   * plan_sheet_extractions.kind gains 'legend-entries' — legend extraction
--     runs reuse the SAME append-only run log + sha256/prompt/model cache as
--     page understanding (typed title-block columns stay null; the full
--     model output lives in raw). CHECK widening only — no data change.
--   * legend_entries — the reviewed per-job vocabulary. Follows the house
--     AI-suggestion state machine (api/_lib/ai-suggestions.js):
--     suggested → accepted | edited | rejected | superseded. Terminal states
--     never transition; re-extraction produces NEW suggestions and never
--     rewrites reviewed history. Downstream consumers (#204 recognition)
--     read accepted|edited rows ONLY — the reviewed state is the vocabulary.
--
-- Dedup (#201 AC: multiple legend sheets/blocks merge into ONE vocabulary):
-- a partial unique index keeps ONE live entry per normalised label per job;
-- the API merges by skipping duplicates and reporting them honestly.
--
-- Symbol crops: the browser crops the entry's bbox from the page PNG
-- (canvas; there is no server-side image library) and the API stores it at
-- jobs/<jobId>/legend-crops/<entryId>.png — under the jobs/ backup prefix,
-- so no backup-manifest change. Crop upload is best-effort: an entry
-- without a crop is still a usable (label-only) vocabulary row.
-- ============================================================================

-- ─── widen the run-log kind vocabulary ──────────────────────────────────────
alter table public.plan_sheet_extractions
  drop constraint plan_sheet_extractions_kind_check;
alter table public.plan_sheet_extractions
  add constraint plan_sheet_extractions_kind_check
  check (kind in ('page-understanding', 'legend-entries'));

-- ─── legend_entries (the reviewed vocabulary) ───────────────────────────────
create table public.legend_entries (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  job_id             text not null,   -- legacy job id (jobs.json)
  origin             text not null check (origin in ('ai', 'human')),
  status             text not null default 'suggested'
                     check (status in ('suggested', 'accepted', 'edited', 'rejected', 'superseded')),
  label              text not null,
  normalized_label   text not null,   -- lower/trim/collapse — the dedupe key
  description        text,
  category           text check (category is null or category in
                       ('Power','Lighting','Switch','Data','Comms','Safety','Mechanical','EV','Appliance','Other')),
  symbol_text        text,            -- model's terse description of the drawn symbol
  symbol_crop_url    text,            -- Blob URL of the cropped symbol cell (best-effort)
  crop_region        jsonb,           -- {x,y,w,h} normalised 0..1 on the source page
  source_plan_id     text,            -- null for origin='human'
  source_page_index  integer check (source_page_index is null or source_page_index >= 0),
  source_page_sha256 text,
  extraction_id      uuid references public.plan_sheet_extractions(id),
  confidence         real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  model              text,            -- null for origin='human'
  prompt_version     text,
  created_at         timestamptz not null default now(),
  created_by_label   text,
  reviewed_at        timestamptz,
  reviewed_by_label  text,
  review_note        text,
  human_label        text,            -- 'edited' correction; original label preserved
  superseded_by      uuid references public.legend_entries(id),
  unique (tenant_id, id)
);
comment on table public.legend_entries is
  'Epic 5 (#201) per-job symbol vocabulary. origin=ai rows follow the suggested→accepted|edited|rejected|superseded machine (terminal states final; re-runs supersede, never rewrite). origin=human rows are added pre-accepted. Effective label = human_label ?? label. Downstream (#204) reads accepted|edited only.';

-- ONE live entry per normalised label per job — the merge invariant.
create unique index legend_entries_live_label_uq
  on public.legend_entries (tenant_id, job_id, normalized_label)
  where status in ('suggested', 'accepted', 'edited');
create index legend_entries_job_idx
  on public.legend_entries (tenant_id, job_id);

alter table public.legend_entries enable row level security;
