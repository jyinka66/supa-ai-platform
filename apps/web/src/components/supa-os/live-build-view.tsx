"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  ChevronRight, File, Folder, Terminal, Play, Square,
  RefreshCw, Sparkles, Shield, Code2, TestTube, Rocket,
} from "lucide-react";
import {
  supaOsApi, builderApi, type BuildSession, type SandboxFile, type SandboxState,
} from "@/lib/api-client";
import { InspectorOverlay } from "@/components/supa-os/inspector-overlay";

const AGENT_TABS = [
  { id: "architect", label: "Architect", icon: Code2, color: "text-accent" },
  { id: "security", label: "Security", icon: Shield, color: "text-warning" },
  { id: "uiux", label: "UI/UX", icon: Sparkles, color: "text-success" },
  { id: "fullstack", label: "Full Stack", icon: Code2, color: "text-accent" },
  { id: "qa", label: "QA", icon: TestTube, color: "text-textMuted" },
] as const;

export function LiveBuildView({ buildId }: { buildId: string }) {
  const [session, setSession] = React.useState<BuildSession | null>(null);
  const [sandbox, setSandbox] = React.useState<SandboxState | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<SandboxFile | null>(null);
  const [activeAgent, setActiveAgent] = React.useState<typeof AGENT_TABS[number]["id"]>("architect");
  const [agentOutputs, setAgentOutputs] = React.useState<Record<string, unknown>>({});
  const [agentRunning, setAgentRunning] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const previewIframeRef = React.useRef<HTMLIFrameElement>(null);
  const [terminalLines, setTerminalLines] = React.useState<Array<{ stream: string; content: string; timestamp: string }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Load build session + sandbox state.
  const loadAll = React.useCallback(async () => {
    try {
      const [buildResult, sandboxResult] = await Promise.all([
        builderApi.sessions.get(buildId),
        supaOsApi.sandbox.get(buildId).catch(() => null),
      ]);
      setSession(buildResult.session);
      setSandbox(sandboxResult);
      if (sandboxResult?.files.length && !selectedFile) {
        setSelectedFile(sandboxResult.files[0]!);
      }
      if (sandboxResult?.terminal?.lines) {
        setTerminalLines(sandboxResult.terminal.lines);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load build");
    } finally {
      setLoading(false);
    }
  }, [buildId, selectedFile]);

  React.useEffect(() => { loadAll(); }, [loadAll]);

  // Poll for status updates every 5s while session is in planning/building.
  React.useEffect(() => {
    if (!session || session.status === "deployed" || session.status === "archived") return;
    const interval = setInterval(loadAll, 5000);
    return () => clearInterval(interval);
  }, [session?.status, loadAll]);

  async function handleRunAgent(role: typeof AGENT_TABS[number]["id"]) {
    setAgentRunning(role);
    try {
      const result = await supaOsApi.build.runAgent(buildId, role);
      setAgentOutputs((prev) => ({ ...prev, [role]: result.output }));
    } catch (err) {
      setTerminalLines((prev) => [...prev, {
        stream: "stderr",
        content: `[ERROR] Agent ${role} failed: ${err instanceof Error ? err.message : "unknown error"}`,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setAgentRunning(null);
    }
  }

  async function handleStartPreview() {
    try {
      const result = await supaOsApi.preview.start(buildId);
      setPreviewUrl(result.preview.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start preview");
    }
  }

  async function handleStopPreview() {
    try {
      await supaOsApi.preview.stop(buildId);
      setPreviewUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop preview");
    }
  }

  async function handleSaveFile(path: string, content: string) {
    try {
      await supaOsApi.sandbox.writeFile(buildId, path, content);
      setSandbox((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          files: prev.files.map((f) => f.path === path ? { ...f, content } : f),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-textMuted">Loading build session…</div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center space-y-md">
          <div className="text-danger">{error}</div>
          <Button variant="outline" onClick={loadAll}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="min-h-screen bg-surfaceMuted">
      <header className="border-b border-border bg-surface">
        <div className="px-lg py-md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-md">
              <a href="/admin/supa-os" className="text-textMuted hover:text-text">← Back</a>
              <h1 className="text-lg font-semibold">{session.name}</h1>
              <StatusBadge status={session.status} />
            </div>
            <div className="flex items-center gap-sm">
              <Button size="sm" variant="outline" onClick={loadAll}>
                <RefreshCw className="w-3 h-3 mr-1" /> Refresh
              </Button>
              {previewUrl ? (
                <Button size="sm" variant="destructive" onClick={handleStopPreview}>
                  <Square className="w-3 h-3 mr-1" /> Stop Preview
                </Button>
              ) : (
                <Button size="sm" onClick={handleStartPreview}>
                  <Play className="w-3 h-3 mr-1" /> Start Preview
                </Button>
              )}
              <Button size="sm" variant="default">
                <Rocket className="w-3 h-3 mr-1" /> Deploy
              </Button>
            </div>
          </div>
          <p className="text-xs text-textMuted mt-1 truncate">{session.originalPrompt}</p>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-md p-md">
        {/* ─── Left pane: file explorer ─── */}
        <Card className="col-span-3 h-[calc(100vh-160px)]">
          <CardHeader className="pb-sm">
            <CardTitle className="text-sm">Files</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100%-50px)]">
              {sandbox?.files.length === 0 && (
                <div className="p-md text-sm text-textMuted">
                  No files yet. Run an agent to scaffold the project.
                </div>
              )}
              {sandbox?.files.map((file) => (
                <button
                  key={file.path}
                  onClick={() => setSelectedFile(file)}
                  className={`flex items-center w-full text-left px-md py-sm text-sm hover:bg-surfaceMuted ${
                    selectedFile?.path === file.path ? "bg-accent/10 text-accent" : ""
                  }`}
                >
                  <File className="w-3 h-3 mr-sm shrink-0" />
                  <span className="truncate">{file.path}</span>
                </button>
              ))}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* ─── Middle pane: editor + agents ─── */}
        <Card className="col-span-6 h-[calc(100vh-160px)] flex flex-col">
          <Tabs defaultValue="editor" className="flex-1 flex flex-col">
            <TabsList className="m-md">
              <TabsTrigger value="editor">Editor</TabsTrigger>
              <TabsTrigger value="architect">Architect</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="uiux">UI/UX</TabsTrigger>
              <TabsTrigger value="fullstack">Full Stack</TabsTrigger>
              <TabsTrigger value="qa">QA</TabsTrigger>
            </TabsList>

            <TabsContent value="editor" className="flex-1 m-0">
              {selectedFile ? (
                <FileEditor
                  file={selectedFile}
                  onSave={(content) => handleSaveFile(selectedFile.path, content)}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-textMuted text-sm">
                  Select a file from the explorer to view its contents.
                </div>
              )}
            </TabsContent>

            {AGENT_TABS.map((agent) => (
              <TabsContent key={agent.id} value={agent.id} className="flex-1 m-0">
                <AgentPanel
                  agent={agent}
                  output={agentOutputs[agent.id]}
                  isRunning={agentRunning === agent.id}
                  onRun={() => handleRunAgent(agent.id)}
                />
              </TabsContent>
            ))}
          </Tabs>
        </Card>

        {/* ─── Right pane: terminal + preview ─── */}
        <Card className="col-span-3 h-[calc(100vh-160px)] flex flex-col">
          <Tabs defaultValue="terminal" className="flex-1 flex flex-col">
            <TabsList className="m-md">
              <TabsTrigger value="terminal"><Terminal className="w-3 h-3 mr-1" /> Terminal</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="reasoning">Reasoning</TabsTrigger>
            </TabsList>

            <TabsContent value="terminal" className="flex-1 m-0 overflow-hidden">
              <TerminalPanel lines={terminalLines} />
            </TabsContent>

            <TabsContent value="preview" className="flex-1 m-0 relative">
              {previewUrl ? (
                <>
                  <iframe
                    ref={previewIframeRef}
                    src={previewUrl}
                    className="w-full h-full border-0"
                    title="Live Preview"
                  />
                  <InspectorOverlay iframeRef={previewIframeRef} />
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-textMuted text-sm p-md text-center">
                  Click "Start Preview" to launch the live preview.
                </div>
              )}
            </TabsContent>

            <TabsContent value="reasoning" className="flex-1 m-0 overflow-auto">
              <div className="p-md text-xs text-textMuted">
                <Button size="sm" variant="outline" className="mb-md">
                  <Sparkles className="w-3 h-3 mr-1" /> Re-run System 2 Reasoning
                </Button>
                <p>The 4-phase reasoning trace (problem decomposition, hypothesis generation, hypothesis testing, conclusion) will appear here after the build is created or when you re-run reasoning.</p>
              </div>
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      {error && (
        <div className="fixed bottom-md right-md rounded-md border border-danger/30 bg-danger/10 p-md text-sm text-danger max-w-md">
          {error}
          <button className="ml-sm text-xs underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────
// FileEditor — simple textarea-based editor (Phase 2 swaps for Monaco).
// ───────────────────────────────────────────────

function FileEditor({ file, onSave }: { file: SandboxFile; onSave: (content: string) => void }) {
  const [content, setContent] = React.useState(file.content);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    setContent(file.content);
    setDirty(false);
  }, [file.path, file.content]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-md py-sm border-b border-border bg-surfaceMuted text-xs">
        <span className="font-mono">{file.path}</span>
        {dirty && <Badge variant="warning">unsaved</Badge>}
      </div>
      <textarea
        value={content}
        onChange={(e) => { setContent(e.target.value); setDirty(true); }}
        className="flex-1 p-md font-mono text-xs bg-surface resize-none focus:outline-none"
        spellCheck={false}
      />
      <div className="flex items-center justify-between px-md py-sm border-t border-border bg-surfaceMuted">
        <span className="text-xs text-textMuted">{content.length} bytes</span>
        <Button size="sm" disabled={!dirty} onClick={() => { onSave(content); setDirty(false); }}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────
// AgentPanel — runs a specific agent + shows output.
// ───────────────────────────────────────────────

function AgentPanel({
  agent, output, isRunning, onRun,
}: {
  agent: typeof AGENT_TABS[number];
  output: unknown;
  isRunning: boolean;
  onRun: () => void;
}) {
  const Icon = agent.icon;
  return (
    <div className="flex flex-col h-full p-md gap-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-sm">
          <Icon className={`w-4 h-4 ${agent.color}`} />
          <span className="font-medium">{agent.label} Agent</span>
        </div>
        <Button size="sm" onClick={onRun} disabled={isRunning}>
          {isRunning ? "Running…" : "Run"}
        </Button>
      </div>
      <ScrollArea className="flex-1 rounded-md border border-border">
        <pre className="p-md text-xs font-mono whitespace-pre-wrap">
          {output ? JSON.stringify(output, null, 2) : "No output yet. Click Run."}
        </pre>
      </ScrollArea>
    </div>
  );
}

// ───────────────────────────────────────────────
// TerminalPanel — shows stdout/stderr lines.
// ───────────────────────────────────────────────

function TerminalPanel({ lines }: { lines: Array<{ stream: string; content: string; timestamp: string }> }) {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { endRef.current?.scrollIntoView(); }, [lines]);

  return (
    <ScrollArea className="h-full bg-text text-surface font-mono text-xs">
      <div className="p-md space-y-0.5">
        {lines.length === 0 && (
          <div className="text-surface/60">No output yet.</div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={line.stream === "stderr" ? "text-danger" : "text-surface/90"}>
            <span className="text-surface/40 mr-sm">{new Date(line.timestamp).toLocaleTimeString()}</span>
            {line.content}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  );
}
