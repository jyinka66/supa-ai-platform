"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { StepProps } from "./types";

/**
 * Last onboarding step — user creates their first "value" (e.g. a note,
 * a project, a contact). Field is intentionally open-ended.
 */
export function StepFirstValue({ initial, onSave }: StepProps) {
  const t = useTranslations("onboarding");
  const [value, setValue] = useState((initial.first_value as string) ?? "");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!value.trim()) return;
    setSubmitting(true);
    onSave({
      first_value: value.trim(),
      onboarding_step: 5, // mirrors TOTAL_STEPS
      onboarding_complete: true,
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold">{t("steps.firstValue")}</h2>
      <label className="block">
        <span className="sr-only">{t("steps.firstValue")}</span>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          required
          minLength={3}
          maxLength={500}
          autoFocus
          placeholder="Write something…"
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-text"
        />
      </label>
      <button
        type="submit"
        disabled={submitting || value.trim().length < 3}
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover disabled:opacity-50"
      >
        {t("actions.finish")}
      </button>
    </form>
  );
}
