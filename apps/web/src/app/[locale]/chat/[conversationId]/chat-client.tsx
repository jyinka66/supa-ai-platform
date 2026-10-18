"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { MessageBubble } from "./message-bubble";
import { Composer } from "./composer";
import type { ConversationRow, MessageRow } from "@/lib/chat/queries";
import type { WorkspaceWithMembership } from "@/lib/workspaces/queries";
import type { Mode } from "@/lib/prompts";
import { MODES } from "@/lib/prompts";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";

interface ChatClientProps {
  conversation: ConversationRow;
  initialMessages: MessageRow[];
  locale: string;
  workspaces: WorkspaceWithMembership[];
  activeWorkspaceId: string;
}

interface StreamingMessage {
  id: string;
  role: "assistant";
  content: string;
  status: "streaming" | "completed" | "error" | "aborted";
}

interface ChatFailure {
  message: string;
  reason?: string;
  nextStep?: string;
  requestId?: string;
}

interface FailedPrompt {
  content: string;
  userMessage: MessageRow;
}

type StreamEvent = {
  phase?: string;
  message?: string;
  text?: string;
  messageId?: string;
  provider?: string;
  fallbackPath?: string[];
  partial?: boolean;
  content?: string;
  allProvidersFailed?: boolean;
  reason?: unknown;
  nextStep?: string;
  requestId?: string;
  status?: string;
  aborted?: boolean;
};

const SUGGESTIONS = [
  { title: "Help me plan my week", prompt: "Help me plan my week. Ask me for any important deadlines if you need them." },
  { title: "Write a professional email", prompt: "Help me write a clear, professional email. Ask me who it is for and what I need to say." },
  { title: "Explain something simply", prompt: "Explain a difficult topic in simple language, with an example." },
  { title: "Turn an idea into a plan", prompt: "Help me turn an idea into a practical step-by-step plan." },
];

function modeTitle(mode: string): string {
  const titles: Record<string, string> = {
    chat: "AI assistant",
    write: "Writing assistant",
    rewrite: "Rewrite",
    summarize: "Summarize",
    translate: "Translate",
    code: "Code helper",
    image: "Image prompt assistant",
    document: "Document assistant",
    plan: "Planning assistant",
  };
  return titles[mode] ?? "AI assistant";
}

function getFailureReason(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  if (Array.isArray(reason)) {
    const parts = reason
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as { provider?: unknown; reason?: unknown };
        const provider = typeof record.provider === "string" ? record.provider : "AI provider";
        const detail = typeof record.reason === "string" ? record.reason : "request failed";
        return `${provider}: ${detail}`;
      })
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(" · ") : undefined;
  }
  if (reason && typeof reason === "object") {
    const record = reason as { message?: unknown; code?: unknown };
    if (typeof record.message === "string") return record.message;
    if (typeof record.code === "string") return record.code;
  }
  return undefined;
}

async function readApiFailure(response: Response): Promise<ChatFailure> {
  const payload = await response.json().catch(() => ({})) as {
    error?: string | { code?: string; message?: string; details?: Record<string, unknown> };
    detail?: string;
    requestId?: string;
  };
  if (payload.error && typeof payload.error === "object") {
    return {
      message: payload.error.message ?? "Supa AI couldn't start that request.",
      reason: getFailureReason(payload.error.details?.reason),
      requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
    };
  }

  const raw = typeof payload.error === "string" ? payload.error : payload.detail;
  const messages: Record<number, string> = {
    401: "Your session has expired. Sign in again, then retry your message.",
    402: "Your workspace has reached its AI usage budget.",
    403: "You don't have access to this conversation.",
    429: "You're sending messages too quickly. Wait a moment and try again.",
    503: "Supa AI is temporarily unavailable. Please retry in a moment.",
  };
  return {
    message: messages[response.status] ?? raw ?? "Supa AI couldn't start that request. Please try again.",
    requestId: payload.requestId,
  };
}

export function ChatClient({ conversation, initialMessages, locale, workspaces, activeWorkspaceId }: ChatClientProps) {
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [activeMode, setActiveMode] = useState<Mode>(
    (MODES as readonly string[]).includes(conversation.mode) ? conversation.mode as Mode : "chat",
  );
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [statusText, setStatusText] = useState("");
  const [statusReason, setStatusReason] = useState<string | undefined>();
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const [failedPrompt, setFailedPrompt] = useState<FailedPrompt | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  const playTone = useCallback((frequencies: number[], force = false) => {
    if (!force && !soundEnabled) return;
    if (typeof window === "undefined") return;

    try {
      const AudioContextCtor = window.AudioContext;
      if (!AudioContextCtor) return;
      const context = audioRef.current ?? new AudioContextCtor();
      audioRef.current = context;
      void context.resume();

      const now = context.currentTime;
      frequencies.forEach((frequency, index) => {
        const start = now + index * 0.13;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.035, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.11);
      });
    } catch {
      // Audio is optional and must never interrupt message delivery.
    }
  }, [soundEnabled]);

  useEffect(() => {
    try {
      setSoundEnabled(window.localStorage.getItem("supa-chat-sounds") !== "off");
    } catch {
      // Storage may be unavailable in private browsing modes.
    }
    return () => {
      if (audioRef.current) void audioRef.current.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: isSending ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, streaming, statusText, failure, isSending]);

  const toggleSound = useCallback(() => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    try {
      window.localStorage.setItem("supa-chat-sounds", next ? "on" : "off");
    } catch {
      // Keep the setting in memory for this tab.
    }
    if (next) playTone([740, 880], true);
  }, [playTone, soundEnabled]);

  const handleSend = useCallback(async (rawContent: string, retryMessage?: MessageRow) => {
    const content = rawContent.trim();
    if (!content || isSending) return;

    setFailure(null);
    setFailedPrompt(null);
    setStatusReason(undefined);
    setStatusText("Connecting to Supa AI…");
    setIsSending(true);

    const userMsg: MessageRow = retryMessage ?? {
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

    if (!retryMessage) {
      setMessages((previous) => [...previous, userMsg]);
    }

    const assistantId = crypto.randomUUID();
    setStreaming({
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
    });
    playTone([520]);

    const idempotencyKey = `${conversation.id}:${Date.now()}:${crypto.randomUUID()}`;
    const controller = new AbortController();
    abortRef.current = controller;

    let streamedText = "";
    let completed = false;
    let finalMessageId: string | undefined;
    let streamFailure: StreamEvent | null = null;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          conversationId: conversation.id,
          parentId: userMsg.parentMessageId,
          clientMessageId: userMsg.id,
          content,
          idempotencyKey,
          language: conversation.languagePref ?? locale,
          mode: activeMode,
        }),
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const apiFailure = await readApiFailure(response);
        throw Object.assign(new Error(apiFailure.message), { chatFailure: apiFailure });
      }
      if (!response.body) {
        throw new Error("Supa AI opened the connection but did not start a response. Please retry.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";

        for (const frame of frames) {
          let eventType = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          if (!dataLines.length) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(dataLines.join("\n")) as StreamEvent;
          } catch {
            // Invalid server events are tracked rather than silently hidden.
            streamFailure = {
              message: "Supa AI sent an unreadable streaming update.",
              reason: "The response connection returned malformed event data.",
            };
            break readLoop;
          }

          if (eventType === "status") {
            if (event.message) setStatusText(event.message);
          } else if (eventType === "delta") {
            if (typeof event.text === "string" && event.text.length > 0) {
              streamedText += event.text;
              setStreaming((previous) => previous ? { ...previous, content: streamedText } : previous);
            }
          } else if (eventType === "fallback") {
            if (event.message) setStatusText(event.message);
            setStatusReason(event.reason ? getFailureReason(event.reason) : undefined);
          } else if (eventType === "error") {
            streamFailure = event;
            break readLoop;
          } else if (eventType === "done") {
            completed = event.status !== "aborted";
            finalMessageId = event.messageId;
            if (event.status === "aborted") {
              streamFailure = {
                partial: true,
                aborted: true,
                content: streamedText,
                message: "Generation stopped. Any text already received is preserved.",
                reason: "You stopped this response.",
              };
            }
            break readLoop;
          } else if (eventType === "expired") {
            streamFailure = {
              message: "The response stream expired before it could be restored.",
              reason: "Start a new message or retry this one.",
            };
            break readLoop;
          }
        }
      }

      buffered += decoder.decode().replace(/\r\n/g, "\n");
      if (!streamFailure && !completed && buffered.trim()) {
        // Consume a final frame not followed by a blank line.
        const lines = buffered.split("\n");
        let eventType = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length) {
          try {
            const event = JSON.parse(dataLines.join("\n")) as StreamEvent;
            if (eventType === "delta" && typeof event.text === "string") {
              streamedText += event.text;
              setStreaming((previous) => previous ? { ...previous, content: streamedText } : previous);
            } else if (eventType === "done") {
              completed = true;
              finalMessageId = event.messageId;
            } else if (eventType === "error") {
              streamFailure = event;
            }
          } catch {
            streamFailure = {
              message: "Supa AI sent an unreadable streaming update.",
              reason: "The response connection returned malformed event data.",
            };
          }
        }
      }

      const currentFailure = streamFailure;
      if (currentFailure) {
        if (currentFailure.partial) {
          const partial = typeof currentFailure.content === "string" ? currentFailure.content : streamedText;
          if (partial.trim()) {
            setMessages((previous) => [...previous, {
              id: finalMessageId ?? assistantId,
              conversationId: conversation.id,
              parentMessageId: userMsg.id,
              role: "assistant",
              content: partial,
              version: 1,
              languageDetected: null,
              promptVersion: null,
              status: currentFailure.aborted ? "aborted" : "error",
              createdAt: new Date(),
            }]);
          }
          setStreaming(null);
          const reason = getFailureReason(currentFailure.reason);
          setFailure({
            message: currentFailure.message ?? "Supa AI stopped before finishing this response.",
            reason,
            nextStep: currentFailure.nextStep,
            requestId: currentFailure.requestId,
          });
          setFailedPrompt({ content, userMessage: userMsg });
          setStatusText("");
          return;
        }

        throw Object.assign(
          new Error(currentFailure.message ?? "Supa AI couldn't finish this response."),
          { chatFailure: {
            message: currentFailure.message ?? "Supa AI couldn't finish this response.",
            reason: getFailureReason(currentFailure.reason),
            nextStep: currentFailure.nextStep,
            requestId: currentFailure.requestId,
          } satisfies ChatFailure },
        );
      }

      if (!completed) {
        throw new Error("The connection closed before Supa AI finished. Retry your message.");
      }
      if (!streamedText.trim()) {
        throw new Error("Supa AI finished without returning any text. Please retry.");
      }

      setMessages((previous) => [...previous, {
        id: finalMessageId ?? assistantId,
        conversationId: conversation.id,
        parentMessageId: userMsg.id,
        role: "assistant",
        content: streamedText,
        version: 1,
        languageDetected: null,
        promptVersion: null,
        status: "completed",
        createdAt: new Date(),
      }]);
      setStreaming(null);
      setFailure(null);
      setFailedPrompt(null);
      setStatusReason(undefined);
      setStatusText("");
      playTone([660, 880]);
    } catch (error) {
      const typed = error as Error & { chatFailure?: ChatFailure };
      if (typed.name === "AbortError") {
        if (streamedText.trim()) {
          setMessages((previous) => [...previous, {
            id: assistantId,
            conversationId: conversation.id,
            parentMessageId: userMsg.id,
            role: "assistant",
            content: streamedText,
            version: 1,
            languageDetected: null,
            promptVersion: null,
            status: "aborted",
            createdAt: new Date(),
          }]);
        }
        setFailure({
          message: "Generation stopped.",
          reason: streamedText.trim() ? "The partial response has been kept in the conversation." : undefined,
        });
      } else {
        const apiFailure = typed.chatFailure;
        setFailure(apiFailure ?? {
          message: typed.message || "Supa AI couldn't finish this response. Please retry.",
        });
        setFailedPrompt({ content, userMessage: userMsg });
      }
      setStreaming(null);
      setStatusText("");
    } finally {
      setIsSending(false);
      abortRef.current = null;
    }
  }, [activeMode, conversation, isSending, locale, messages, playTone]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retryLast = useCallback(() => {
    if (failedPrompt) void handleSend(failedPrompt.content, failedPrompt.userMessage);
  }, [failedPrompt, handleSend]);

  const greetingMode = modeTitle(activeMode);

  const changeMode = async (nextMode: Mode) => {
    if (nextMode === activeMode || isSending || savingMode) return;
    setSavingMode(true);
    setModeError(null);
    try {
      const response = await fetch("/api/conversations/" + conversation.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: { message?: string } | string;
      };
      if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(message || "Could not switch AI mode.");
      }
      setActiveMode(nextMode);
    } catch (cause) {
      setModeError(cause instanceof Error ? cause.message : "Could not switch AI mode.");
    } finally {
      setSavingMode(false);
    }
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-[#f7f8fc] text-slate-950">
      <WorkspaceSidebar
        locale={locale}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        activePage="studio"
        conversationId={conversation.id}
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#f7f8fc] text-slate-950">
      <header className="z-10 flex min-h-[72px] items-center justify-between border-b border-slate-200 bg-white/95 px-4 shadow-sm backdrop-blur sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/${locale}/dashboard`}
            aria-label="Back to dashboard"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50 hover:text-violet-700"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-sm shadow-violet-700/20">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">Ask Supa AI</h1>
            <p className="mt-0.5 truncate text-xs text-slate-500">{greetingMode} · Conversation saved to your workspace</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="sr-only">AI capability</span>
            <select
              value={activeMode}
              disabled={isSending || savingMode}
              onChange={(event) => void changeMode(event.target.value as Mode)}
              aria-label="AI capability"
              className="h-10 max-w-[132px] rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-100 disabled:opacity-60 sm:max-w-[180px] sm:px-3"
            >
              {MODES.map((mode) => <option key={mode} value={mode}>{modeTitle(mode)}</option>)}
            </select>
          </label>
          <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Ready to help
          </span>
          <button
            type="button"
            onClick={toggleSound}
            title={soundEnabled ? "Turn response sounds off" : "Turn response sounds on"}
            aria-label={soundEnabled ? "Turn response sounds off" : "Turn response sounds on"}
            aria-pressed={soundEnabled}
            className={`flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition ${soundEnabled ? "border-violet-200 bg-violet-50 text-violet-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            <span className="hidden sm:inline">{soundEnabled ? "Sound on" : "Sound off"}</span>
          </button>
        </div>
      </header>
      {modeError && <div role="alert" className="border-b border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800">{modeError}</div>}

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:px-7 sm:py-8">
            {messages.length === 0 && !streaming && (
              <div className="mx-auto flex w-full max-w-3xl flex-col items-center pb-4 pt-8 text-center sm:pt-12">
                <div className="flex h-16 w-16 items-center justify-center rounded-[22px] bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-lg shadow-violet-700/20">
                  <Sparkles className="h-8 w-8" />
                </div>
                <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-violet-700">Your AI workspace</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Ask Supa AI anything.</h2>
                <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500 sm:text-base">
                  Get help writing, learning, planning, coding, or thinking through a problem. Your reply appears as it is generated.
                </p>

                <div className="mt-8 grid w-full gap-3 text-left sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.title}
                      type="button"
                      disabled={isSending}
                      onClick={() => void handleSend(suggestion.prompt)}
                      className="group rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md disabled:opacity-50"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-slate-800">{suggestion.title}</span>
                        <Zap className="h-4 w-4 text-violet-600 transition group-hover:scale-110" />
                      </span>
                      <span className="mt-2 block text-xs leading-5 text-slate-500">{suggestion.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
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
                statusText={statusText || "Supa AI is thinking…"}
              />
            )}

            {failure && (
              <div className="ml-0 flex gap-3" role="alert" aria-live="assertive">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-700">
                  <CircleAlert className="h-4 w-4" />
                </div>
                <div className="min-w-0 max-w-2xl flex-1 rounded-2xl border border-rose-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">{failure.message}</p>
                  {failure.reason && <p className="mt-2 text-xs leading-5 text-slate-600">What happened: {failure.reason}</p>}
                  {failure.nextStep && <p className="mt-2 text-xs leading-5 text-slate-600">{failure.nextStep}</p>}
                  {failure.requestId && <p className="mt-2 text-[11px] text-slate-400">Reference: {failure.requestId}</p>}
                  {failedPrompt && (
                    <button
                      type="button"
                      onClick={retryLast}
                      disabled={isSending}
                      className="mt-3 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Retry response
                    </button>
                  )}
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {statusReason && isSending && (
          <div className="mx-auto w-full max-w-4xl px-4 pb-2 text-xs text-slate-500 sm:px-7">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5">
              <CircleAlert className="h-3.5 w-3.5 text-amber-600" />
              Provider fallback: {statusReason}
            </span>
          </div>
        )}

        <div className="border-t border-slate-200 bg-white/95 px-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-3 sm:px-7 sm:pt-4 lg:pb-4">
          <div className="mx-auto w-full max-w-4xl">
            <Composer
              onSend={(content) => void handleSend(content)}
              onStop={handleStop}
              isSending={isSending}
              disabled={isSending}
              placeholder="Ask Supa AI anything…"
            />
            <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[11px] text-slate-400">
              <span>Enter to send · Shift + Enter for a new line</span>
              <span className="hidden items-center gap-1 sm:inline-flex"><Check className="h-3 w-3" /> Replies stream live</span>
            </div>
          </div>
        </div>
      </section>
    </main>
    </div>
  );
}
