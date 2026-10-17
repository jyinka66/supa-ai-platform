-- Product-account TOTP factor storage, separate from admin_users.mfa_secret.
-- TOTP secrets are encrypted by the application; raw recovery codes are never persisted.
create table product_mfa_factors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  totp_secret_encrypted text not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_mfa_factors enable row level security;
-- No client policies: only trusted server-side application code can access factors.
comment on table product_mfa_factors is
  'Product-user TOTP factors; secrets are AES-256-GCM encrypted and separate from admin MFA.';
