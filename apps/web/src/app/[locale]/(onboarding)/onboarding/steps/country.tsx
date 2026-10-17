"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { StepProps } from "./types";

const COUNTRIES = [
  "US", "GB", "CA", "AU", "DE", "FR", "ES", "PT", "BR", "MX",
  "AR", "JP", "KR", "CN", "IN", "SA", "AE", "EG", "MA", "ZA",
  "NG", "KE", "TR", "IT", "NL", "BE", "CH", "SE", "NO", "DK",
] as const;

export function StepCountry({ initial, onSave, showSkip }: StepProps) {
  const t = useTranslations("onboarding.steps");
  const [value, setValue] = useState<string>((initial.country as string) ?? "");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({ country: value || null });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold">{t("country")}</h2>
      <label className="block">
        <span className="sr-only">{t("country")}</span>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-text"
          required
        >
          <option value="" disabled>
            Select your country
          </option>
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
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
        <button type="button" onClick={() => onSave({ country: null })} className="link block w-full text-center text-sm">
          Skip
        </button>
      )}
    </form>
  );
}
