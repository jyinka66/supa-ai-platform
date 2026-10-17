"use client";

interface ProgressDotsProps {
  current: number;
  total: number;
}

export function ProgressDots({ current, total }: ProgressDotsProps) {
  return (
    <ol className="flex items-center justify-center gap-2" aria-label="Progress">
      {Array.from({ length: total }, (_, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={i}
            aria-current={state === "current" ? "step" : undefined}
            className={[
              "h-2 rounded-full transition-all",
              state === "done" && "w-2 bg-accent",
              state === "current" && "w-6 bg-accent",
              state === "todo" && "w-2 bg-border",
            ]
              .filter(Boolean)
              .join(" ")}
          />
        );
      })}
    </ol>
  );
}
