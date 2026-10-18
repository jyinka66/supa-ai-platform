"use client";

import { useState } from "react";
import { Check, Copy, Sparkles, UserRound } from "lucide-react";
import { clsx } from "clsx";
import type { MessageRow } from "@/lib/chat/queries";

interface MessageBubbleProps {
  message: MessageRow;
  isStreaming?: boolean;
  statusText?: string;
}

function renderContent(text: string) {
  // Keep responses safe by rendering text as React nodes (never as raw HTML).
  // Code fences are displayed as separate, scrollable code blocks.
  const parts: Array<{ type: "text" | "code"; value: string; language?: string }> = [];
  const fence = /```([a-zA-Z0-9_+.-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    parts.push({ type: "code", language: match[1] || undefined, value: match[2] ?? "" });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: "text", value: text.slice(lastIndex) });

  return parts.map((part, index) => part.type === "code" ? (
    <div key={`code-${index}`} className="my-3 overflow-hidden rounded-xl border border-slate-700/70 bg-slate-950 text-slate-100">
      {part.language && (
        <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {part.language}
        </div>
      )}
      <pre className="overflow-x-auto p-3 text-xs leading-5"><code>{part.value.replace(/\n$/, "")}</code></pre>
    </div>
  ) : (
    <p key={`text-${index}`} className="whitespace-pre-wrap break-words text-sm leading-7">
      {part.value}
    </p>
  ));
}

export function MessageBubble({ message, isStreaming, statusText }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const isThinking = Boolean(isStreaming && !message.content.trim());

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className={clsx("group flex w-full gap-3 sm:gap-4", isUser ? "flex-row-reverse" : "flex-row")}>
      <div
        aria-hidden="true"
        className={clsx(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
          isUser
            ? "bg-slate-200 text-slate-700"
            : "bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-sm shadow-violet-700/15",
        )}
      >
        {isUser ? <UserRound className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </div>

      <div className={clsx("flex min-w-0 max-w-[calc(100%-3rem)] flex-col", isUser ? "items-end" : "items-start")}>
        <div className="mb-1.5 flex items-center gap-2 px-1">
          <span className="text-xs font-semibold text-slate-700">{isUser ? "You" : "Supa AI"}</span>
          {!isUser && isStreaming && (
            <span className="text-[10px] font-medium text-violet-700">LIVE RESPONSE</span>
          )}
        </div>

        <div
          className={clsx(
            "min-w-0 max-w-full rounded-2xl px-4 py-3.5 sm:px-5",
            isUser
              ? "rounded-tr-md bg-violet-600 text-white shadow-sm shadow-violet-700/10"
              : message.status === "error"
                ? "rounded-tl-md border border-rose-200 bg-rose-50 text-slate-800"
                : "rounded-tl-md border border-slate-200/80 bg-white text-slate-800 shadow-sm shadow-slate-900/[0.025]",
          )}
        >
          {isThinking ? (
            <div className="flex min-w-[225px] flex-col gap-2.5 py-1" aria-live="polite" aria-label={statusText || "Supa AI is thinking"}>
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-red-500 motion-reduce:animate-none" style={{ animationDelay: "0ms" }} />
                <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-red-500 motion-reduce:animate-none" style={{ animationDelay: "140ms" }} />
                <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-red-500 motion-reduce:animate-none" style={{ animationDelay: "280ms" }} />
              </div>
              <p className="text-xs text-slate-500">{statusText || "Supa AI is thinking through your request…"}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {renderContent(message.content)}
                {isStreaming && (
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-violet-500 align-middle motion-reduce:animate-none" aria-hidden="true" />
                )}
              </div>
              {!isUser && message.status !== "completed" && !isStreaming && (
                <div className="mt-2 border-t border-slate-200/70 pt-2 text-[11px] text-slate-500">
                  {message.status === "error" && "This response may be incomplete."}
                  {message.status === "aborted" && "Generation stopped. Partial text preserved."}
                  {message.status === "streaming" && "Response is still streaming…"}
                </div>
              )}
            </>
          )}
        </div>

        {!isUser && message.content.trim() && !isStreaming && (
          <button
            type="button"
            onClick={() => void copyMessage()}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 opacity-100 transition hover:bg-slate-100 hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100"
            aria-label="Copy response"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy response"}
          </button>
        )}
      </div>
    </article>
  );
}
