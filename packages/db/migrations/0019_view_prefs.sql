-- ============ WORK VIEW PREFERENCES ============
-- Per-user + per-folder view preferences (grid/list/kanban/timeline).
--
-- The server is view-agnostic — views are pure presentation over the
-- /api/work/items response. The server only needs to persist preferences
-- so they survive page reloads.
--
-- Default: grid view, newest sort, comfortable density.
-- Kanban groups by `type` (derivable from the existing `type` field).
-- Timeline groups by `updated_at` (derivable from the existing field).

-- ============ PROFILES: work_view_prefs ============
-- Per-user default view preferences (applies when no folder override exists).
alter table public.profiles
  add column if not exists work_view_prefs jsonb not null default
    '{"view":"grid","sort":"newest","density":"comfortable"}'::jsonb;

comment on column public.profiles.work_view_prefs is
  'Per-user default view preferences for /work. JSONB: {view, sort, density}.';

-- ============ WORK_FOLDERS: view_prefs ============
-- Per-folder view override (e.g. kanban for an "Invoices" folder).
-- Takes precedence over the user's default when set.
alter table public.work_folders
  add column if not exists view_prefs jsonb;

comment on column public.work_folders.view_prefs is
  'Per-folder view override. NULL = use the user default. JSONB: {view, sort, density}.';
