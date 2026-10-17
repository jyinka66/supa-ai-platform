"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";

interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isSending: boolean;
  disabled: boolean;
  placeholder: string;
}

export function Composer({ onSend, onStop, isSending, disabled, placeholder }: ComposerProps) {
  const [value, setValue] = useState("");

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || isSending || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter to send, Shift+Enter for newline.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed && !isSending && !disabled) {
        onSend(trimmed);
        setValue("");
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        maxLength={32_000}
        className="max-h-40 min-h-[44px] flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-textMuted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        style={{ height: "auto" }}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        }}
      />

      {isSending ? (
        <button
          type="button"
          onClick={onStop}
          className="flex h-11 w-11 items-center justify-center rounded-md bg-danger text-white transition hover:bg-danger/90"
          aria-label="Stop generation"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim() || disabled}
          className="flex h-11 w-11 items-center justify-center rounded-md bg-accent text-white transition hover:bg-accentHover disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send message"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      )}
    </form>
  );
}
