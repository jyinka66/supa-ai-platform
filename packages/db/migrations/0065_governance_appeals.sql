-- ───────────────────────────────────────────────
-- 0065_governance_appeals.sql
-- Governance appeals — users appealing algorithmic decisions.
--
-- Appeal types: user_appeal, policy_exception, executive_override, abuse_dispute.
-- Workflow: filed → reviewed → decided → (resolved | escalated_to_committee).
--
-- Referenced by:
--   - lib/governance/governance-dashboards.ts (appeal counts)
--   - lib/governance/governance-audit-trail.ts (appeal evidence lookup)
--   - API routes: POST /api/governance/appeals, GET /api/governance/appeals/[id]
-- ───────────────────────────────────────────────

create table governance_appeals (
  id                    uuid primary key default gen_random_uuid(),

  -- What's being appealed.
  decision_id           uuid,                                 -- the governance_decision being appealed.
  appeal_type           text not null check (appeal_type in (
                          'user_appeal', 'policy_exception',
                          'executive_override', 'abuse_dispute'
                        )),

  -- Who's appealing.
  appellant_id          text not null,                        -- user_id or 'system'.

  -- The grounds (mandatory, free text).
  grounds               text not null,

  -- Evidence (structured — references to documents, logs, etc.).
  evidence              jsonb not null default '[]'::jsonb,

  -- Workflow state.
  status                text not null check (status in (
                          'filed', 'under_review', 'awaiting_committee',
                          'resolved', 'withdrawn', 'timeout_closed'
                        )) default 'filed',

  -- Current step in the 5-step appeal workflow.
  current_step          text not null default 'filed',

  -- Resolution (filled in when status='resolved').
  outcome               text check (outcome in ('upheld', 'overturned', 'partial', 'rejected')),
  resolved_by           text,                                 -- admin_id or 'committee'.
  resolved_at           timestamptz,
  resolution_notes      text,

  -- Committee routing (if escalated).
  committee_decision_id  text,

  -- Timestamps.
  filed_at              timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- SLA tracking (must be reviewed within SLA or auto-escalate).
  sla_deadline          timestamptz
);

create index idx_gov_appeals_decision on governance_appeals (decision_id);
create index idx_gov_appeals_appellant on governance_appeals (appellant_id, filed_at desc);
create index idx_gov_appeals_status on governance_appeals (status, filed_at desc);

comment on table governance_appeals is
  'global_system — user appeals against governance decisions. 5-step workflow: filed → under_review → awaiting_committee → resolved | withdrawn | timeout_closed.';
