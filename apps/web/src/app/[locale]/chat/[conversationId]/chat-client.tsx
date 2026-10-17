"use client";

import { useState, useRef, useCallback, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { MessageBubble } from "./message-bubble";
import { Composer } from "./composer";
import { Spinner } from "@supa/ui/spinner";
import type { ConversationRow, MessageRow } from "@/lib/chat/queries";

interface ChatClientProps {
  conversation: ConversationRow;
  initialMessages: MessageRow[];
  locale: string;
}

interface StreamingMessage {
  id: string;
  role: "assistant";
  content: string;
  status: "streaming" | "completed" | "error";
}

export function ChatClient({ conversation, initialMessages, locale }: ChatClientProps) {
  const t = useTranslations("chat");
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleSend = useCallback(
    async (content: string) => {
      if (!content.trim() || isSending) return;
      setError(null);
      setIsSending(true);

      // Optimistic user message.
      const userMsg: MessageRow = {
        id: crypto.randomUUID(),
        conversationId: conversation.id,
        parentMessageId: messages[messages.length - 1]?.id ?? null,
        role: "user",
        content,
        version: 1,
        languageDetected: null,
        promptVersion: null,
        status: "completed",
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Start streaming assistant message.
      const streamId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      setStreaming({
        id: assistantId,
        role: "assistant",
        content: "",
        status: "streaming",
      });

      const idempotencyKey = `${conversation.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversation.id,
            parentId: userMsg.parentMessageId,
            content,
            idempotencyKey,
            language: conversation.languagePref ?? locale,
            mode: conversation.mode,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "stream_failed");
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evt of events) {
            const lines = evt.split("\n");
            let eventType = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              if (eventType === "delta") {
                setStreaming((prev) =>
                  prev
                    ? { ...prev, content: prev.content + parsed.text }
                    : prev,
                );
              } else if (eventType === "done") {
                // Finalize — add as a permanent message.
                setStreaming((prev) => {
                  if (prev) {
                    setMessages((msgs) => [
                      ...msgs,
                      {
                        id: parsed.messageId ?? assistantId,
                        conversationId: conversation.id,
                        parentMessageId: userMsg.id,
                        role: "assistant",
                        content: prev.content,
                        version: 1,
                        languageDetected: null,
                        promptVersion: null,
                        status: "completed",
                        createdAt: new Date(),
                      },
                    ]);
                  }
                  return null;
                });
              } else if (eventType === "error") {
                if (parsed.partial) {
                  // Show partial content as an error message.
                  setStreaming(null);
                  setMessages((msgs) => [
                    ...msgs,
                    {
                      id: assistantId,
                      conversationId: conversation.id,
                      parentMessageId: userMsg.id,
                      role: "assistant",
                      content: parsed.content,
                      version: 1,
                      languageDetected: null,
                      promptVersion: null,
                      status: "error",
                      createdAt: new Date(),
                    },
                  ]);
                } else {
                  throw new Error(parsed.allProvidersFailed ? "all_providers_failed" : "stream_error");
                }
              } else if (eventType === "fallback") {
                // Provider failover — show transient status.
                setStreaming((prev) =>
                  prev ? { ...prev, content: prev.content } : prev,
                );
              }
            } catch {
              // Skip malformed event.
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setError(t("aborted"));
        } else {
          setError((err as Error).message);
        }
        setStreaming(null);
      } finally {
        setIsSending(false);
        abortRef.current = null;
      }
    },
    [conversation, messages, isSending, locale, t],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">
            {conversation.title || t("untitled")}
          </h1>
          <p className="text-xs text-textMuted">{t(`modes.${conversation.mode}`)}</p>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4">
          {messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-textMuted">
              <p className="text-sm">{t("emptyState")}</p>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {streaming && (
            <MessageBubble
              message={{
                id: streaming.id,
                conversationId: conversation.id,
                parentMessageId: null,
                role: "assistant",
                content: streaming.content,
                version: 1,
                languageDetected: null,
                promptVersion: null,
                status: streaming.status,
                createdAt: new Date(),
              }}
              isStreaming
            />
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger"
            >
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border p-4">
        <div className="mx-auto max-w-3xl">
          <Composer
            onSend={handleSend}
            onStop={handleStop}
            isSending={isSending}
            disabled={false}
            placeholder={t("composerPlaceholder")}
          />
        </div>
      </div>
    </div>
  );
}
