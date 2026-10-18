"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";

interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isSending: boolean;
  disabled: boolean;
  placeholder: string;
}

export function Composer({ onSend, onStop, isSending, disabled, placeholder }: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function resizeTextarea() {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 192)}px`;
  }

  function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = value.trim();
    if (!content || isSending || disabled) return;
    onSend(content);
    setValue("");
    requestAnimationFrame(resizeTextarea);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitMessage();
    }
  }

  return (
    <form
      onSubmit={submitMessage}
      className="rounded-[22px] border border-slate-200 bg-white p-2 shadow-[0_10px_35px_-25px_rgba(15,23,42,0.35)] transition focus-within:border-violet-300 focus-within:ring-4 focus-within:ring-violet-100/80"
    >
      <label htmlFor="supa-chat-composer" className="sr-only">Ask Supa AI</label>
      <textarea
        ref={textareaRef}
        id="supa-chat-composer"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          requestAnimationFrame(resizeTextarea);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={isSending || disabled}
        rows={1}
        maxLength={32_000}
        className="block max-h-48 min-h-[48px] w-full resize-none border-0 bg-transparent px-3 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:cursor-wait disabled:opacity-70"
        aria-describedby="supa-chat-composer-hint"
      />
      <div className="flex items-center justify-between gap-3 px-1 pb-1 pt-1">
        <p id="supa-chat-composer-hint" className="px-2 text-[11px] text-slate-400">
          {value.length > 0 ? `${value.length.toLocaleString()} / 32,000` : "Supa AI can make mistakes. Review important details."}
        </p>
        {isSending ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 focus:outline-none focus:ring-4 focus:ring-rose-100"
            aria-label="Stop generating response"
          >
            <Square className="h-3.5 w-3.5 fill-current" /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim() || disabled}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm transition hover:bg-violet-700 focus:outline-none focus:ring-4 focus:ring-violet-100 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            aria-label="Send message to Supa AI"
            title="Send message"
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        )}
      </div>
    </form>
  );
}
