import { useMutation, useQuery } from "@tanstack/react-query";
import { supabaseBrowser } from "@/lib/supabase/client";

const TOTAL_STEPS = 5; // mirrors STEPS.length in onboarding/page.tsx

type OnboardingProfile = {
  id: string;
  onboarding_step: number | null;
  onboarding_complete: boolean | null;
  language?: string | null;
  country?: string | null;
  role_type?: string | null;
  bio?: string | null;
  company?: string | null;
} & Record<string, unknown>;

type SavePayload = {
  onboarding_step: number;
  onboarding_complete?: boolean;
  onboarding_skipped?: boolean;
} & Partial<OnboardingProfile>;

export function useOnboarding() {
  const profile = useQuery({
    queryKey: ["profile", "me"],
    queryFn: async (): Promise<OnboardingProfile | null> => {
      const {
        data: { user },
        error: authError,
      } = await supabaseBrowser.auth.getUser();
      if (authError || !user) throw new Error("unauthenticated");

      const { data, error } = await supabaseBrowser
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();

      if (error) throw error;
      return data as OnboardingProfile | null;
    },
    retry: false,
    staleTime: 0, // always refetch on mount — onboarding state changes are time-sensitive
  });

  const save = useMutation({
    mutationFn: async (payload: SavePayload) => {
      const {
        data: { user },
        error: authError,
      } = await supabaseBrowser.auth.getUser();
      if (authError || !user) throw new Error("unauthenticated");

      const { error } = await supabaseBrowser
        .from("profiles")
        .update(payload)
        .eq("id", user.id);
      if (error) throw error;
      await profile.refetch();
    },
    retry: 0,
  });

  const currentStep = profile.data?.onboarding_complete
    ? TOTAL_STEPS // user already finished — clamp to last step (dashboard will redirect)
    : (profile.data?.onboarding_step ?? 0);

  return {
    step: currentStep,
    data: profile.data ?? {},
    isLoading: profile.isLoading,
    error: profile.error ?? save.error,
    saveStep: save.mutate,
    skip: () =>
      save.mutate({
        onboarding_step: TOTAL_STEPS - 1,
        onboarding_complete: true,
        onboarding_skipped: true,
      }),
  };
}
