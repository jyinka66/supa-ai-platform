"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { StepProps } from "./types";

const ROLES = ["individual", "business", "enterprise"] as const;
type RoleType = (typeof ROLES)[number];

export function StepRole({ initial, onSave, showSkip }: StepProps) {
  const t = useTranslations("onboarding.steps");
  const [value, setValue] = useState<RoleType>(
    (initial.role_type as RoleType) ?? "individual",
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({ role_type: value });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold">{t("role")}</h2>
      <div className="space-y-2">
        {ROLES.map((role) => (
          <label
            key={role}
            className={[
              "flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition",
              value === role
                ? "border-accent bg-accent/5"
                : "border-border bg-surface hover:bg-surfaceMuted",
            ].join(" ")}
          >
            <input
              type="radio"
              name="role"
              value={role}
              checked={value === role}
              onChange={() => setValue(role)}
              className="h-4 w-4 accent-accent"
            />
            <span className="text-sm font-medium capitalize">{role}</span>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accentHover"
      >
        Continue
      </button>
      {showSkip && (
        <button type="button" onClick={() => onSave({ role_type: value })} className="link block w-full text-center text-sm">
          Skip
        </button>
      )}
    </form>
  );
}
