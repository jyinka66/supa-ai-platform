-- ───────────────────────────────────────────────
-- 0024_business_tables.sql
-- Business tables — money spine + CRM + invoicing
-- ───────────────────────────────────────────────

-- Enums
CREATE TYPE public.expense_status AS ENUM ('draft', 'recorded', 'approved', 'rejected', 'reimbursed');
CREATE TYPE public.invoice_status AS ENUM ('draft', 'issued', 'partial', 'paid', 'voided');
CREATE TYPE public.customer_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE public.activity_source AS ENUM ('manual', 'system', 'ai');

-- ─── Monetary facts — THE single source of truth ───
CREATE TABLE IF NOT EXISTS monetary_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  native_amount_minor BIGINT NOT NULL,
  native_currency TEXT NOT NULL,
  recorded_rate JSONB,
  as_of TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monetary_facts_ws ON monetary_facts(workspace_id, as_of);
CREATE INDEX IF NOT EXISTS idx_monetary_facts_source ON monetary_facts(source_id, kind);
CREATE INDEX IF NOT EXISTS idx_monetary_facts_kind ON monetary_facts(kind, as_of);

-- ─── Invoice sequence — atomic numbering ───
CREATE TABLE IF NOT EXISTS invoice_sequences (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit-note')),
  next BIGINT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, profile_id, kind)
);

-- ─── Invoices ───
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  customer_id UUID,
  number TEXT,
  status invoice_status NOT NULL DEFAULT 'draft',
  line_items JSONB NOT NULL DEFAULT '[]',
  tax_mode TEXT NOT NULL DEFAULT 'per-line',
  currency TEXT NOT NULL,
  totals JSONB NOT NULL DEFAULT '{}',
  issued_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  due_in_days INTEGER NOT NULL DEFAULT 30,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_ws_profile ON invoices(workspace_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(workspace_id, profile_id, number) WHERE number IS NOT NULL;

-- ─── Credit notes ───
CREATE TABLE IF NOT EXISTS credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_ws_profile ON credit_notes(workspace_id, profile_id);

-- ─── Customers ───
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  business_name TEXT,
  emails JSONB NOT NULL DEFAULT '[]',
  phones JSONB NOT NULL DEFAULT '[]',
  addresses JSONB NOT NULL DEFAULT '[]',
  currency TEXT NOT NULL DEFAULT 'NGN',
  tax_id TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  groups JSONB NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  status customer_status NOT NULL DEFAULT 'active',
  created_by UUID NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_ws_status ON customers(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_ws_name ON customers(workspace_id, name);

-- ─── Activity facts — the timeline ───
CREATE TABLE IF NOT EXISTS activity_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  deal_id UUID,
  kind TEXT NOT NULL,
  ref_id TEXT,
  content TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  source activity_source NOT NULL DEFAULT 'manual',
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_customer ON activity_facts(customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activity_deal ON activity_facts(deal_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activity_ws_kind ON activity_facts(workspace_id, kind, occurred_at);

-- ─── Merge records — for customer dedup ───
CREATE TABLE IF NOT EXISTS merge_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  survivor_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  merged_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_resolutions JSONB NOT NULL DEFAULT '{}',
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversible_until TIMESTAMPTZ NOT NULL,
  reversed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_merge_survivor ON merge_records(survivor_id);
CREATE INDEX IF NOT EXISTS idx_merge_merged ON merge_records(merged_id);

-- ─── Import batches — for CSV import undo ───
CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_customer_ids JSONB NOT NULL DEFAULT '[]',
  duplicate_customer_ids JSONB NOT NULL DEFAULT '[]',
  summary JSONB NOT NULL DEFAULT '{}',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversible_until TIMESTAMPTZ NOT NULL,
  reversed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_ws ON import_batches(workspace_id, imported_at);

-- ─── Deals — the pipeline ───
CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  value_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  expected_close TIMESTAMPTZ NOT NULL,
  stage_id TEXT NOT NULL DEFAULT 'new',
  probability NUMERIC,
  source TEXT NOT NULL DEFAULT 'manual',
  owner UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deals_ws_stage ON deals(workspace_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner);

-- ─── Deal-invoice links — for the conversion loop ───
CREATE TABLE IF NOT EXISTS deal_invoice_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  converted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_by UUID NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_invoice_link ON deal_invoice_links(deal_id, invoice_id);

-- ─── Expenses ───
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  merchant TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL,
  category TEXT NOT NULL,
  tax_deductible BOOLEAN NOT NULL DEFAULT false,
  tax_rate TEXT,
  receipt_ref TEXT,
  recurring_rule_id UUID,
  recurring_period_key TEXT,
  mileage JSONB,
  status expense_status NOT NULL DEFAULT 'draft',
  created_by UUID NOT NULL,
  paid_by TEXT NOT NULL DEFAULT 'cash',
  reimbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_ws_profile ON expenses(workspace_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(workspace_id, category, date);

-- ─── Recurring expense rules ───
CREATE TABLE IF NOT EXISTS recurring_expense_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  merchant TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  category TEXT NOT NULL,
  tax_deductible BOOLEAN NOT NULL DEFAULT false,
  tax_rate TEXT,
  frequency TEXT NOT NULL,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ,
  amount_mode TEXT NOT NULL DEFAULT 'fixed',
  auto_record BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_rules_ws ON recurring_expense_rules(workspace_id, active);

-- ─── RLS policies — cross-tenant isolation ───
ALTER TABLE monetary_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_invoice_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_expense_rules ENABLE ROW LEVEL SECURITY;

-- RLS: workspace members can access their workspace's rows.
-- The auth.uid() → workspace_members check is the runtime gate;
-- the lint rule (no raw DB access outside repositories) is the structural gate;
-- the property test is the regression gate.
DROP POLICY IF EXISTS monetary_facts_ws_isolation ON monetary_facts;
CREATE POLICY monetary_facts_ws_isolation ON monetary_facts
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS invoices_ws_isolation ON invoices;
CREATE POLICY invoices_ws_isolation ON invoices
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS customers_ws_isolation ON customers;
CREATE POLICY customers_ws_isolation ON customers
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS deals_ws_isolation ON deals;
CREATE POLICY deals_ws_isolation ON deals
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS expenses_ws_isolation ON expenses;
CREATE POLICY expenses_ws_isolation ON expenses
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS activity_facts_ws_isolation ON activity_facts;
CREATE POLICY activity_facts_ws_isolation ON activity_facts
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS credit_notes_ws_isolation ON credit_notes;
CREATE POLICY credit_notes_ws_isolation ON credit_notes
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS invoice_sequences_ws_isolation ON invoice_sequences;
CREATE POLICY invoice_sequences_ws_isolation ON invoice_sequences
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS merge_records_ws_isolation ON merge_records;
CREATE POLICY merge_records_ws_isolation ON merge_records
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS import_batches_ws_isolation ON import_batches;
CREATE POLICY import_batches_ws_isolation ON import_batches
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS deal_invoice_links_ws_isolation ON deal_invoice_links;
CREATE POLICY deal_invoice_links_ws_isolation ON deal_invoice_links
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
DROP POLICY IF EXISTS recurring_expense_rules_ws_isolation ON recurring_expense_rules;
CREATE POLICY recurring_expense_rules_ws_isolation ON recurring_expense_rules
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));
