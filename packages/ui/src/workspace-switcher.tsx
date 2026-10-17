"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { clsx } from "clsx";

export interface SwitcherWorkspace {
  id: string;
  slug: string;
  name: string;
  logo_path: string | null;
  is_personal: boolean;
  plan: string;
  workspace_members: { role: "owner" | "admin" | "member" | "viewer" }[];
}

interface WorkspaceSwitcherProps {
  workspaces: SwitcherWorkspace[];
  /** Currently active workspace id (read from cookie on the server). */
  activeId: string | null;
  /** Base URL prefix — typically the locale, e.g. "/en". */
  basePath: string;
  /** Called when the user selects a workspace. Sets the `ws` cookie. */
  onSelect?: (wsId: string) => void;
}

/**
 * Workspace switcher dropdown.
 *
 * - Personal workspace labeled "Personal" with a distinct user icon.
 * - Members see their role badge next to each workspace.
 * - Active workspace is persisted in cookie `ws` via a server action,
 *   so Server Components read the same value on the next request.
 *
 * Accessibility:
 *   - Trigger button has `aria-haspopup="listbox"` + `aria-expanded`.
 *   - Arrow-key navigation between options.
 *   - Esc closes; click-outside closes.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeId,
  basePath,
  onSelect,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFocusIndex(-1);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape; arrow-key nav.
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setFocusIndex(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(i + 1, workspaces.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && focusIndex >= 0) {
        e.preventDefault();
        const ws = workspaces[focusIndex];
        if (ws) handleSelect(ws.id);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, focusIndex, workspaces]);

  function handleSelect(wsId: string) {
    onSelect?.(wsId);
    document.cookie = `ws=${wsId}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    setOpen(false);
    // Navigate to the workspace dashboard so the new context loads fresh.
    window.location.href = `${basePath}/dashboard`;
  }

  if (!active) {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-textMuted"
      >
        No workspaces
      </button>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition hover:bg-surfaceMuted"
      >
        {active.logo_path ? (
          <Image src={active.logo_path} alt="" width={20} height={20} className="h-5 w-5 rounded" />
        ) : (
          <span aria-hidden="true" className="h-5 w-5 rounded bg-accent/10 text-xs text-accent">
            {active.is_personal ? "👤" : active.name[0]?.toUpperCase() ?? "?"}
          </span>
        )}
        <span>{active.is_personal ? "Personal" : active.name}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={clsx("h-4 w-4 transition-transform", open && "rotate-180")}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Switch workspace"
          className="absolute left-0 top-full z-10 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        >
          {workspaces.map((ws, i) => {
            const role = ws.workspace_members[0]?.role ?? "viewer";
            return (
              <li key={ws.id} role="option" aria-selected={ws.id === active?.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(ws.id)}
                  onMouseEnter={() => setFocusIndex(i)}
                  className={clsx(
                    "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition",
                    focusIndex === i ? "bg-surfaceMuted" : "bg-surface",
                    ws.id === active?.id && "font-semibold",
                  )}
                >
                  {ws.is_personal ? (
                    <span aria-hidden="true" className="text-base">👤</span>
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded bg-accent/10 text-xs font-medium text-accent">
                      {ws.name[0]?.toUpperCase() ?? "?"}
                    </span>
                  )}
                  <span className="flex-1 truncate">
                    {ws.is_personal ? "Personal" : ws.name}
                  </span>
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      role === "owner" && "bg-accent/15 text-accent",
                      role === "admin" && "bg-warning/15 text-warning",
                      role === "member" && "bg-surfaceMuted text-textMuted",
                      role === "viewer" && "bg-surfaceMuted text-textMuted",
                    )}
                  >
                    {role}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
