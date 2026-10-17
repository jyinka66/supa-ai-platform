"use client";

import { clsx } from "clsx";
import type { MessageRow } from "@/lib/chat/queries";

interface MessageBubbleProps {
  message: MessageRow;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      className={clsx(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* Avatar */}
      <div
        className={clsx(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium",
          isUser ? "bg-accent text-white" : "bg-surfaceMuted text-textMuted",
        )}
        aria-hidden="true"
      >
        {isUser ? "U" : "AI"}
      </div>

      {/* Bubble */}
      <div
        className={clsx(
          "max-w-[80%] rounded-lg px-4 py-2",
          isUser
            ? "bg-accent text-white"
            : message.status === "error"
              ? "bg-danger/5 text-text border border-danger/30"
              : "bg-surfaceMuted text-text",
        )}
      >
        {/* Content — rendered as preformatted text to preserve newlines. */}
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.content}
          {isStreaming && (
            <span
              className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-current align-middle"
              aria-hidden="true"
            />
          )}
        </div>

        {/* Status badge for non-completed messages */}
        {!isUser && message.status !== "completed" && !isStreaming && (
          <div className="mt-1 text-xs text-textMuted">
            {message.status === "error" && "⚠ Error"}
            {message.status === "aborted" && "⏹ Aborted"}
            {message.status === "streaming" && "⏳ Streaming..."}
          </div>
        )}
      </div>
    </div>
  );
}
