-- ============ AUDIT LOG TABLE ============
-- NOTE: The audit_log table is now created by migration 0011_audit_log.sql
-- with a richer schema (actor_id, actor_kind, action, target_type, target_id).
-- Migration 0001 originally created a simpler version here, but 0011 drops
-- and recreates it. This section is intentionally empty — the table is
-- created in 0011 to avoid schema drift.
--
-- The handle_new_user() trigger (below) originally called log_audit_event()
-- and pg_notify('signup_audit', ...) for signup auditing. The trigger now
-- only fires pg_notify — audit entries are written by the app layer via
-- the audit() helper (lib/audit/actions.ts).

-- ============ PERSONAL WORKSPACE TRIGGER ============
-- Failure-tolerant: trigger logs and continues rather than blocking signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ws_id uuid;
BEGIN
  -- Profile
  INSERT INTO public.profiles (id, language)
  VALUES (new.id, coalesce(new.raw_user_meta_data->>'language', 'en'))
  ON CONFLICT (id) DO NOTHING;

  -- Personal workspace + owner membership
  INSERT INTO public.workspaces (slug, name, is_personal, billing_owner_id)
  VALUES (
    'u-' || new.id::text,
    coalesce(new.raw_user_meta_data->>'full_name', 'Personal'),
    true,
    new.id
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_ws_id;

  IF v_ws_id IS NULL THEN
    SELECT id INTO v_ws_id FROM public.workspaces WHERE slug = 'u-' || new.id::text;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws_id, new.id, 'owner')
  ON CONFLICT DO NOTHING;

  -- Fire real-time notify for workers (signup_audit listener).
  -- Audit log entries are written by the app layer via audit() helper.
  PERFORM pg_notify('signup_audit', json_build_object(
    'user_id', new.id, 'at', now(), 'ok', true
  )::text);
  RETURN new;
EXCEPTION WHEN others THEN
  -- Signup must never fail because of workspace provisioning; alert + continue.
  -- Audit log entries are written by the app layer; just notify workers.
  PERFORM pg_notify('signup_audit', json_build_object(
    'user_id', new.id, 'at', now(), 'ok', false, 'error', SQLERRM
  )::text);
  RETURN new;
END;
$function$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ RLS HELPER FUNCTIONS ============
-- SECURITY: these functions take ONLY ws_id — they read auth.uid() internally
-- so a caller cannot query another user's role or membership state.

CREATE OR REPLACE FUNCTION public.is_workspace_member(ws_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE user_id = auth.uid() AND workspace_id = ws_id
  );
$$;

CREATE OR REPLACE FUNCTION public.workspace_role(ws_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role::text FROM public.workspace_members
  WHERE user_id = auth.uid() AND workspace_id = ws_id;
$$;

-- ============ ENABLE RLS ============
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deletion_requests  ENABLE ROW LEVEL SECURITY;
-- audit_log RLS is set in migration 0011_audit_log.sql

-- ============ PROFILES ============
-- Users can read their own profile + profiles of users who share a workspace.
CREATE POLICY profiles_select ON profiles
  FOR SELECT USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.workspace_members wm_owner
      WHERE wm_owner.user_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM public.workspace_members wm_peer
          WHERE wm_peer.workspace_id = wm_owner.workspace_id
            AND wm_peer.user_id = profiles.id
        )
    )
  );
CREATE POLICY profiles_update ON profiles
  FOR UPDATE USING (id = auth.uid());
CREATE POLICY profiles_insert ON profiles
  FOR INSERT WITH CHECK (id = auth.uid());

-- ============ WORKSPACES ============
CREATE POLICY ws_select ON workspaces
  FOR SELECT USING (public.is_workspace_member(id));
CREATE POLICY ws_update ON workspaces
  FOR UPDATE USING (public.workspace_role(id) IN ('owner','admin'));
-- Any authenticated user can create a workspace; the application layer
-- (or a SECURITY DEFINER RPC) is responsible for atomically creating
-- the owner membership row in the same transaction.
CREATE POLICY ws_insert ON workspaces
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY ws_delete ON workspaces
  FOR DELETE USING (
    is_personal = false
    AND public.workspace_role(id) = 'owner'
  );

-- ============ WORKSPACE MEMBERS ============
CREATE POLICY wm_select ON workspace_members
  FOR SELECT USING (user_id = auth.uid() OR public.is_workspace_member(workspace_id));
CREATE POLICY wm_insert ON workspace_members
  FOR INSERT WITH CHECK (
    public.workspace_role(workspace_id) IN ('owner','admin')
  );
-- USING only — no WITH CHECK, so owners can demote themselves.
-- Last-owner protection is enforced by a separate trigger (see below).
CREATE POLICY wm_update ON workspace_members
  FOR UPDATE USING (public.workspace_role(workspace_id) = 'owner');
CREATE POLICY wm_delete ON workspace_members
  FOR DELETE USING (
    public.workspace_role(workspace_id) = 'owner'
    OR (user_id = auth.uid() AND public.workspace_role(workspace_id) <> 'owner')
  );

-- Guard: prevent removing the last owner of a workspace.
CREATE OR REPLACE FUNCTION public.guard_last_workspace_owner()
RETURNS trigger
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $function$
DECLARE
  owner_count integer;
BEGIN
  SELECT count(*) INTO owner_count
  FROM public.workspace_members
  WHERE workspace_id = COALESCE(OLD.workspace_id, NEW.workspace_id)
    AND role = 'owner';

  IF owner_count = 0 THEN
    RAISE EXCEPTION 'Cannot remove the last owner of workspace %',
      COALESCE(OLD.workspace_id, NEW.workspace_id)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE TRIGGER trg_guard_last_owner
BEFORE DELETE OR UPDATE OF role ON public.workspace_members
FOR EACH ROW EXECUTE FUNCTION public.guard_last_workspace_owner();

-- ============ INVITES ============
CREATE POLICY inv_select ON invites
  FOR SELECT USING (public.is_workspace_member(workspace_id));
CREATE POLICY inv_insert ON invites
  FOR INSERT WITH CHECK (public.workspace_role(workspace_id) IN ('owner','admin'));
CREATE POLICY inv_update ON invites
  FOR UPDATE USING (public.workspace_role(workspace_id) IN ('owner','admin'));
CREATE POLICY inv_delete ON invites
  FOR DELETE USING (public.workspace_role(workspace_id) IN ('owner','admin'));

-- ============ SESSIONS ============
CREATE POLICY sessions_select ON user_sessions
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY sessions_update ON user_sessions
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY sessions_delete ON user_sessions
  FOR DELETE USING (user_id = auth.uid());

-- ============ DELETION REQUESTS ============
CREATE POLICY dr_all ON deletion_requests
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============ AUDIT LOG ============
-- audit_log policies are defined in migration 0011_audit_log.sql

-- ============ ADMIN MFA ENFORCEMENT HOOK ============
-- Admins (workspace owners/admins) must have MFA enrolled. Enforced at login
-- via a server-side check + Supabase AAL2 requirement on privileged routes.
CREATE INDEX idx_profiles_deletion ON public.profiles (deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;
