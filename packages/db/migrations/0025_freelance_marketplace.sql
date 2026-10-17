-- ───────────────────────────────────────────────
-- 0025_freelance_marketplace.sql
-- Freelance marketplace tables — supa-board + escrow + work-packaging
-- ───────────────────────────────────────────────

-- Enums
CREATE TYPE IF NOT EXISTS job_status AS ENUM ('captured', 'proposing', 'active', 'delivered', 'paid', 'closed');
CREATE TYPE IF NOT EXISTS listing_status AS ENUM ('draft', 'published', 'closed');
CREATE TYPE IF NOT EXISTS application_status AS ENUM ('draft', 'submitted', 'shortlisted', 'client_info_requested', 'hired', 'withdrawn', 'rejected');
CREATE TYPE IF NOT EXISTS contract_status AS ENUM ('draft', 'active', 'completed', 'disputed', 'cancelled');
CREATE TYPE IF NOT EXISTS milestone_status AS ENUM ('pending', 'active', 'submitted', 'changes_requested', 'approved', 'paid');
CREATE TYPE IF NOT EXISTS sample_tier AS ENUM ('verified', 'self_added');
CREATE TYPE IF NOT EXISTS ledger_entry_type AS ENUM ('escrow_funded', 'escrow_released', 'fee_collected', 'payout_initiated', 'payout_confirmed', 'payout_failed', 'refund_issued', 'adjustment');
CREATE TYPE IF NOT EXISTS payout_status AS ENUM ('in_transit', 'confirmed', 'failed');

-- ─── Freelance jobs ───
CREATE TABLE IF NOT EXISTS freelance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'supa',
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  discipline TEXT NOT NULL,
  skills JSONB NOT NULL DEFAULT '[]',
  budget_minor BIGINT NOT NULL,
  budget_currency TEXT NOT NULL,
  budget_type TEXT NOT NULL DEFAULT 'fixed',
  deadline TIMESTAMPTZ,
  status job_status NOT NULL DEFAULT 'captured',
  client_ref UUID NOT NULL,
  external_platform TEXT,
  external_url TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freelance_jobs_ws ON freelance_jobs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_freelance_jobs_client ON freelance_jobs(client_ref);
CREATE INDEX IF NOT EXISTS idx_freelance_jobs_discipline ON freelance_jobs(discipline);

-- ─── Listings ───
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES freelance_jobs(id) ON DELETE CASCADE,
  status listing_status NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ NOT NULL,
  budget_minor BIGINT NOT NULL,
  budget_currency TEXT NOT NULL,
  budget_type TEXT NOT NULL DEFAULT 'fixed',
  ai_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listings_ws ON listings(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_listings_job ON listings(job_id);

-- ─── Applications ───
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  freelancer_ws_id UUID NOT NULL,
  cover_letter TEXT NOT NULL,
  rate_minor BIGINT NOT NULL,
  rate_currency TEXT NOT NULL,
  days INTEGER NOT NULL,
  attached_work_item_ids JSONB NOT NULL DEFAULT '[]',
  proposal_meta JSONB NOT NULL DEFAULT '{}',
  status application_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_applications_listing ON applications(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_freelancer ON applications(freelancer_ws_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_listing_freelancer ON applications(listing_id, freelancer_ws_id);

-- ─── Contracts ───
CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_ws_id UUID NOT NULL,
  freelancer_ws_id UUID NOT NULL,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
  job_id UUID NOT NULL REFERENCES freelance_jobs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  total_amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status contract_status NOT NULL DEFAULT 'draft',
  auto_release_days INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contracts_freelancer ON contracts(freelancer_ws_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_client ON contracts(client_ws_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_job ON contracts(job_id);

-- ─── Milestones ───
CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status milestone_status NOT NULL DEFAULT 'pending',
  submission_note TEXT,
  submission_attachments JSONB DEFAULT '[]',
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  milestone_fact_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_milestones_contract ON milestones(contract_id, status);

-- ─── Reviews (double-blind, gated by completed-contract fact) ───
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  contract_completed_fact_id UUID NOT NULL,
  direction TEXT NOT NULL,
  reviewer_ws_id UUID NOT NULL,
  reviewee_ws_id UUID NOT NULL,
  rating INTEGER NOT NULL,
  text TEXT,
  submitted_at TIMESTAMPTZ NOT NULL,
  contract_completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_contract ON reviews(contract_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_ws_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_ws_id);

-- ─── Work samples (portfolio pieces) ───
CREATE TABLE IF NOT EXISTS work_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tier sample_tier NOT NULL,
  milestone_fact_id UUID,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL,
  deliverable_refs JSONB NOT NULL DEFAULT '[]',
  disciplines JSONB NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_samples_ws ON work_samples(workspace_id, visibility);
CREATE INDEX IF NOT EXISTS idx_work_samples_milestone ON work_samples(milestone_fact_id);

-- ─── Escrow ledger entries (append-only, double-entry) ───
CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type ledger_entry_type NOT NULL,
  debit_minor BIGINT,
  debit_currency TEXT,
  credit_minor BIGINT,
  credit_currency TEXT,
  contra_entry_id UUID,
  ref_type TEXT NOT NULL,
  ref_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency ON ledger_entries(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_ledger_ws ON ledger_entries(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(ref_type, ref_id);

-- ─── Payouts ───
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status payout_status NOT NULL DEFAULT 'in_transit',
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_idempotency ON payouts(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_payouts_ws ON payouts(workspace_id, status);

-- ─── RLS policies — cross-tenant isolation ───
ALTER TABLE freelance_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS freelance_jobs_ws_isolation ON freelance_jobs
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS listings_ws_isolation ON listings
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS applications_ws_isolation ON applications
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS contracts_ws_isolation ON contracts
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS milestones_ws_isolation ON milestones
  USING (contract_id IN (SELECT id FROM contracts WHERE workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())));
CREATE POLICY IF NOT EXISTS reviews_ws_isolation ON reviews
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS work_samples_ws_isolation ON work_samples
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS ledger_entries_ws_isolation ON ledger_entries
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS payouts_ws_isolation ON payouts
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
