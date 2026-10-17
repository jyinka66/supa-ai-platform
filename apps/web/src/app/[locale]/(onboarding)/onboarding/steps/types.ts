import type { ComponentType } from "react";

export interface StepProps {
  initial: Record<string, unknown>;
  onSave: (payload: Record<string, unknown>) => void;
  onSkip: () => void;
  showSkip: boolean;
}

export type StepComponent = ComponentType<StepProps>;
