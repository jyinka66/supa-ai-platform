"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/config";
import type { StepProps } from "./types";

export function StepLanguage({ initial, onSave, showSkip }: StepProps) {
  const t = useTranslations("onboarding.steps");
  const [value, setValue] = useState<Locale>(
    (initial.language as Locale) ?? "en",
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({ language: value });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold">{t("language")}</h2>
      <label className="block">
        <span className="sr-only">{t("language")}</span>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value as Locale)}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-text"
        >
          {LOCALES.map((loc) => (
            <option key={loc} value={loc}>
              {LOCALE_LABELS[loc]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover"
      >
        Continue
      </button>
      {showSkip && (
        <button type="button" onClick={() => onSave({ language: value })} className="link block w-full text-center text-sm">
          Skip
        </button>
      )}
    </form>
  );
}
