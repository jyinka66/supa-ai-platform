-- ───────────────────────────────────────────────
-- 0063_supa_os_build_sessions.sql
-- Supa OS Build Sessions — the atomic unit of Supa AI Build.
--
-- A Build Session is a long-lived workspace that owns:
--   - A plan (what to build).
--   - A repository (the actual code).
--   - A build (compiled artifact).
--   - A test run (pass/fail evidence).
--   - A preview (live running application).
--   - A deployment (where it's published).
--
-- "No 'I've created your app' unless Supa AI actually created the files,
--  ran the project, passed the build, and has a verifiable artifact."
--
-- Referenced by:
--   - lib/builder/build-session.ts (createBuildSession, getBuildSession,
--     listBuildSessions, updateBuildSessionPlan, updateBuildSessionStatus,
--     hasVerifiableArtifact)
--   - lib/builder/deploy-states.ts (getDeployStateReport)
--   - API routes: POST/GET/DELETE /api/supa-os/build/[id]
-- ───────────────────────────────────────────────

create table build_sessions (
  -- Identity.
  id                    uuid primary key default gen_random_uuid(),

  -- Ownership + workspace.
  owner_id              uuid not null,                        -- the admin who created it.
  ws_id                 uuid not null,                        -- workspace context.

  -- Human-readable label (derived from prompt's first sentence).
  name                  text not null,

  -- The original natural-language prompt that kicked off the build.
  original_prompt       text not null,

  -- Platform target.
  platform              text not null check (platform in ('web', 'mobile', 'full_stack')),

  -- Lifecycle status.
  status                text not null check (status in (
                          'planning', 'building', 'testing', 'previewing',
                          'deployed', 'published', 'monitoring',
                          'paused', 'failed', 'archived'
                        )) default 'planning',

  -- The structured plan (11 plan elements: product_requirements, screens_pages,
  -- user_flows, database_schema, authentication, apis, ui_system, integrations,
  -- permissions, deployment_target, environment_config).
  plan                  jsonb not null default '{}'::jsonb,

  -- Build artifacts — populated as the build progresses. Each is null until
  -- the corresponding stage completes.
  repo_url              text,                                 -- git URL (after scaffolding).
  build_artifact_hash   text,                                 -- sha256 of the build artifact.
  test_results          jsonb,                                -- { passed, failed, total, duration_ms }.
  preview_url           text,                                 -- live preview URL.
  deployment_target     text,                                 -- 'vercel' | 'netlify' | 'aws_amplify' | ...

  -- Timestamps.
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_build_sessions_owner on build_sessions (owner_id, created_at desc);
create index idx_build_sessions_ws on build_sessions (ws_id, created_at desc);
create index idx_build_sessions_status on build_sessions (status, created_at desc);

comment on table build_sessions is
  'global_system — Supa OS Build Sessions. Each row is an atomic build pipeline: plan → scaffold → build → test → preview → deploy → publish. The verifiable-artifact gate (repo_url + build_artifact_hash + test_results + preview_url all non-null) gates the "your app is ready" claim.';
