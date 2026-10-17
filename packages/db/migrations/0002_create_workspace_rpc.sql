-- ============ CREATE_WORKSPACE RPC ============
-- Atomically creates a workspace + owner membership row in a single transaction.
-- Called from the POST /api/workspaces route (defense in depth — RLS would
-- otherwise require two separate inserts and the second one might fail).

CREATE OR REPLACE FUNCTION public.create_workspace(
  p_name text,
  p_slug text,
  p_owner_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ws_id uuid;
  v_existing_slug text;
BEGIN
  -- Reject if slug already taken.
  SELECT slug INTO v_existing_slug FROM public.workspaces WHERE slug = p_slug FOR UPDATE;
  IF v_existing_slug IS NOT NULL THEN
    RAISE EXCEPTION 'Slug % already in use', p_slug
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.workspaces (slug, name, is_personal, billing_owner_id)
  VALUES (p_slug, p_name, false, p_owner_id)
  RETURNING id INTO v_ws_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws_id, p_owner_id, 'owner')
  ON CONFLICT DO NOTHING;

  RETURN v_ws_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_workspace(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workspace(text, text, uuid) TO authenticated;

-- ============ PROFILES.METADATA ============
-- JSON column for onboarding steps that collect non-structured data
-- (goals array, first_value text, etc.) without requiring a migration per step.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL;

-- Allow RLS read of own metadata (covered by existing profiles_select policy).
COMMENT ON COLUMN public.profiles.metadata IS
  'Onboarding + feature flags bag. Stored as JSONB to avoid schema churn. Do not store PII here.';
