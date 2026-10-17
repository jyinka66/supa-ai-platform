"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { StepProps } from "./types";

const GOALS = [
  "personal",
  "team_collab",
  "client_work",
  "education",
  "research",
  "automation",
] as const;
type Goal = (typeof GOALS)[number];

export function StepGoals({ initial, onSave, showSkip }: StepProps) {
  const t = useTranslations("onboarding.steps");
  const [selected, setSelected] = useState<Set<Goal>>(
    new Set((initial.goals as Goal[] | undefined) ?? []),
  );

  function toggle(goal: Goal) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(goal)) next.delete(goal);
      else next.add(goal);
      return next;
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({ goals: Array.from(selected) });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold">{t("goals")}</h2>
      <div className="grid grid-cols-2 gap-2">
        {GOALS.map((goal) => (
          <button
            key={goal}
            type="button"
            onClick={() => toggle(goal)}
            className={[
              "rounded-md border px-3 py-2 text-sm transition",
              selected.has(goal)
                ? "border-accent bg-accent/5 text-accent"
                : "border-border bg-surface hover:bg-surfaceMuted",
            ].join(" ")}
          >
            {goal.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <button
        type="submit"
        disabled={selected.size === 0}
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover disabled:opacity-50"
      >
        Continue
      </button>
      {showSkip && (
        <button type="button" onClick={() => onSave({ goals: [] })} className="link block w-full text-center text-sm">
          Skip
        </button>
      )}
    </form>
  );
}
