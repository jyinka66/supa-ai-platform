import { clsx } from "clsx";
import type { ReactNode } from "react";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  children?: ReactNode;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "An unexpected error occurred. Please try again.",
  onRetry,
  children,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={clsx(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-danger/30 bg-danger/5 p-8 text-center",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-10 w-10 text-danger"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div>
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        <p className="mt-1 text-sm text-textMuted">{description}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-text transition hover:bg-surfaceMuted"
        >
          Retry
        </button>
      )}
      {children}
    </div>
  );
}
