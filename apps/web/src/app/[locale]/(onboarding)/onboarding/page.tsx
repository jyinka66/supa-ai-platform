"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ComponentType } from "react";
import { useOnboarding } from "./use-onboarding";
import { StepLanguage } from "./steps/language";
import { StepCountry } from "./steps/country";
import { StepRole } from "./steps/role";
import { StepGoals } from "./steps/goals";
import { StepFirstValue } from "./steps/first-value";
import { ProgressDots } from "./progress-dots";
import { Spinner } from "@supa/ui/spinner";
import { ErrorState } from "@supa/ui/error-state";
import { posthog } from "@/lib/analytics/posthog";

interface StepProps {
  initial: Record<string, unknown>;
  onSave: (payload: Record<string, unknown>) => void;
  onSkip: () => void;
  showSkip: boolean;
}

const STEPS: ComponentType<StepProps>[] = [
  StepLanguage,
  StepCountry,
  StepRole,
  StepGoals,
  StepFirstValue,
];

export default function OnboardingPage() {
  const router = useRouter();
  const pathname = usePathname();
  const locale = pathname.split("/")[1] || "en";
  const t = useTranslations("onboarding");
  const { step, data, isLoading, isSaving, error, saveStep, skip } = useOnboarding();

  // Completion is persisted in the profile before navigating away. This also
  // handles users who revisit onboarding after finishing it on another device.
  useEffect(() => {
    if (!isLoading && data.onboarding_complete === true) {
      router.replace("/" + locale + "/dashboard");
    }
  }, [data.onboarding_complete, isLoading, locale, router]);

  if (isLoading || data.onboarding_complete === true) {
    return (
      <div className="flex justify-center py-24" role="status" aria-live="polite">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <ErrorState onRetry={() => window.location.reload()} />;
  }

  // Bounds-check step in case the persisted value is out of range (e.g. after a downgrade).
  const safeStep = Math.max(0, Math.min(step, STEPS.length - 1));
  const StepComponent = STEPS[safeStep]!;
  const isLastStep = safeStep >= STEPS.length - 1;

  return (
    <div className="space-y-6">
      <ProgressDots current={safeStep} total={STEPS.length} />
      <StepComponent
        initial={data}
        onSave={(payload: Record<string, unknown>) => {
          posthog.capture("onboarding_step_complete", { step: safeStep, ...payload });
          saveStep(payload as never);
        }}
        onSkip={() => {
          posthog.capture("onboarding_step_skipped", { step: safeStep });
          skip();
        }}
        showSkip={!isLastStep}
      />
      {!isLastStep && (
        <button
          type="button"
          disabled={isSaving}
          className="link"
          onClick={() => {
            posthog.capture("onboarding_skip_all");
            skip();
          }}
        >
          {isSaving ? "Finishing setup…" : t("skipAll")}
        </button>
      )}
    </div>
  );
}
