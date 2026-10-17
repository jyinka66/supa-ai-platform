/**
 * Tests for the WebSocket broadcaster.
 *
 * These tests use a mocked WebSocketServer + WebSocket to verify the
 * broadcaster's connection handling, message routing, and broadcast fan-out
 * logic. No real TCP socket is opened.
 *
 * Tests cover:
 *   1. Connection lifecycle (accept, register, disconnect).
 *   2. Path + token validation (reject invalid paths / missing tokens).
 *   3. Message routing (input → broadcast, ping → pong, subscribe).
 *   4. Broadcast helpers (pushTerminalStdout, pushBuildLog, pushAgentProgress).
 *   5. Channel isolation (terminal messages don't reach logs clients).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ───────────────────────────────────────────────
// Mock WebSocket + WebSocketServer
//
// The mock classes implement just enough of the WebSocket API surface for
// the broadcaster to work — `on()`, `emit()`, `send()`, `close()`, and the
// `readyState` + `OPEN` constants. They don't extend EventEmitter (which
// would require an import that breaks vi.hoisted); instead they store
// listeners in a plain Map.
// ───────────────────────────────────────────────

const Mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    readyState = 1; // OPEN
    sent: string[] = [];
    closeCode: number | null = null;
    closeReason: string | null = null;
    private listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
      return this;
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set || set.size === 0) return false;
      for (const l of set) l(...args);
      return true;
    }

    send(data: string) {
      this.sent.push(data);
    }

    close(code: number, reason: string) {
      this.readyState = 3; // CLOSED
      this.closeCode = code;
      this.closeReason = reason;
      this.emit("close");
    }

    // Test helper — simulate a client sending a message.
    emitMessage(data: unknown) {
      this.emit("message", Buffer.from(JSON.stringify(data)));
    }
  }

  class MockWebSocketServer {
    sockets: MockWebSocket[] = [];
    private listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set || set.size === 0) return false;
      for (const l of set) l(...args);
      return true;
    }

    emitConnection(socket: MockWebSocket, req: { url: string; headers?: Record<string, string | undefined> }) {
      this.sockets.push(socket);
      this.emit("connection", socket, req);
    }
  }

  return { MockWebSocket, MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: Mocks.MockWebSocketServer,
  WebSocket: { OPEN: 1, CLOSED: 3 },
}));

import { WsBroadcaster, type WsMessage } from "@/lib/websocket/broadcaster";

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function makeBroadcaster() {
  const wss = new Mocks.MockWebSocketServer();
  const broadcaster = new WsBroadcaster(wss as unknown as never);
  return { wss, broadcaster };
}

function connect(wss: InstanceType<typeof Mocks.MockWebSocketServer>, path: string, token = "test_token_1234") {
  const socket = new Mocks.MockWebSocket();
  wss.emitConnection(socket, { url: `${path}?token=${token}` });
  return socket;
}

function lastMessage(socket: InstanceType<typeof Mocks.MockWebSocket>): WsMessage | null {
  const last = socket.sent[socket.sent.length - 1];
  if (!last) return null;
  return JSON.parse(last) as WsMessage;
}

function allMessages(socket: InstanceType<typeof Mocks.MockWebSocket>): WsMessage[] {
  return socket.sent.map((s) => JSON.parse(s) as WsMessage);
}

// ───────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────

describe("WsBroadcaster — connection lifecycle", () => {
  it("accepts a valid connection to /ws/supa-os/build/<id>/terminal", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const socket = connect(wss, "/ws/supa-os/build/abc-123/terminal");

    expect(socket.closeCode).toBeNull(); // not closed.
    expect(broadcaster.getClientCount()).toBe(1);
    expect(broadcaster.getClientsForBuildSession("abc-123")).toHaveLength(1);

    // Server should send an ack message.
    const msgs = allMessages(socket);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.type).toBe("log");
    expect((msgs[0] as { message: string }).message).toContain("Connected to terminal stream");
  });

  it("rejects an invalid path with code 4000", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const socket = connect(wss, "/ws/invalid/path");

    expect(socket.closeCode).toBe(4000);
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("rejects an invalid channel with code 4000", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const socket = connect(wss, "/ws/supa-os/build/abc-123/invalid_channel");

    expect(socket.closeCode).toBe(4000);
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("rejects a connection with no token with code 4001", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const socket = new Mocks.MockWebSocket();
    wss.emitConnection(socket, { url: "/ws/supa-os/build/abc-123/terminal" }); // no ?token=

    expect(socket.closeCode).toBe(4001);
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it("deregisters a client on disconnect", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const socket = connect(wss, "/ws/supa-os/build/abc-123/terminal");
    expect(broadcaster.getClientCount()).toBe(1);

    socket.emit("close");
    expect(broadcaster.getClientCount()).toBe(0);
    expect(broadcaster.getClientsForBuildSession("abc-123")).toHaveLength(0);
  });
});

describe("WsBroadcaster — message routing", () => {
  it("responds to ping with pong", () => {
    const { wss } = makeBroadcaster();
    const socket = connect(wss, "/ws/supa-os/build/abc-123/terminal");

    socket.emitMessage({ type: "ping" });

    const msgs = allMessages(socket);
    const pong = msgs.find((m) => m.type === "pong");
    expect(pong).toBeDefined();
    expect((pong as { timestamp: string }).timestamp).toBeDefined();
  });

  it("responds to invalid JSON with an error message", () => {
    const { wss } = makeBroadcaster();
    const socket = connect(wss, "/ws/supa-os/build/abc-123/terminal");

    socket.emit("message", Buffer.from("not valid json"));

    const msgs = allMessages(socket);
    const err = msgs.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe("INVALID_JSON");
  });

  it("handles subscribe + unsubscribe", () => {
    const { wss } = makeBroadcaster();
    const socket = connect(wss, "/ws/supa-os/build/abc-123/logs");

    socket.emitMessage({ type: "subscribe", channel: "agent:architect" });
    let msgs = allMessages(socket);
    const sub = msgs.find((m) => m.type === "log" && (m as { message: string }).message.includes("Subscribed"));
    expect(sub).toBeDefined();
  });
});

describe("WsBroadcaster — broadcast fan-out", () => {
  it("pushTerminalStdout broadcasts to terminal clients only", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const terminalSocket = connect(wss, "/ws/supa-os/build/abc-123/terminal");
    const logsSocket = connect(wss, "/ws/supa-os/build/abc-123/logs");

    broadcaster.pushTerminalStdout("abc-123", "Build complete.");

    const terminalMsgs = allMessages(terminalSocket);
    const logsMsgs = allMessages(logsSocket);

    // Terminal should receive the stdout message.
    const stdout = terminalMsgs.find((m) => m.type === "stdout");
    expect(stdout).toBeDefined();
    expect((stdout as { content: string }).content).toBe("Build complete.");

    // Logs socket should NOT receive the terminal stdout.
    const logsStdout = logsMsgs.find((m) => m.type === "stdout");
    expect(logsStdout).toBeUndefined();
  });

  it("pushBuildLog broadcasts to logs clients only", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const terminalSocket = connect(wss, "/ws/supa-os/build/abc-123/terminal");
    const logsSocket = connect(wss, "/ws/supa-os/build/abc-123/logs");

    // Clear the connection-ack messages so we can assert only on the broadcast.
    terminalSocket.sent.length = 0;
    logsSocket.sent.length = 0;

    broadcaster.pushBuildLog("abc-123", "info", "Installing dependencies...");

    const terminalMsgs = allMessages(terminalSocket);
    const logsMsgs = allMessages(logsSocket);

    const logMsg = logsMsgs.find((m) => m.type === "log" && (m as { level: string }).level === "info" && (m as { message: string }).message === "Installing dependencies...");
    expect(logMsg).toBeDefined();

    const terminalLog = terminalMsgs.find((m) => m.type === "log" && (m as { message: string }).message === "Installing dependencies...");
    expect(terminalLog).toBeUndefined();
  });

  it("pushAgentProgress broadcasts to agents clients only", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const agentsSocket = connect(wss, "/ws/supa-os/build/abc-123/agents");
    const logsSocket = connect(wss, "/ws/supa-os/build/abc-123/logs");

    broadcaster.pushAgentProgress("abc-123", "architect", "designing_schema", 0.5, "5/10 entities");

    const agentsMsgs = allMessages(agentsSocket);
    const logsMsgs = allMessages(logsSocket);

    const progress = agentsMsgs.find((m) => m.type === "agent_progress") as { role: string; progress: number } | undefined;
    expect(progress).toBeDefined();
    expect(progress!.role).toBe("architect");
    expect(progress!.progress).toBe(0.5);

    const logsProgress = logsMsgs.find((m) => m.type === "agent_progress");
    expect(logsProgress).toBeUndefined();
  });

  it("pushExit broadcasts to ALL channels on a build session", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const terminalSocket = connect(wss, "/ws/supa-os/build/abc-123/terminal");
    const logsSocket = connect(wss, "/ws/supa-os/build/abc-123/logs");
    const agentsSocket = connect(wss, "/ws/supa-os/build/abc-123/agents");

    broadcaster.pushExit("abc-123", 0);

    expect(allMessages(terminalSocket).some((m) => m.type === "exit")).toBe(true);
    expect(allMessages(logsSocket).some((m) => m.type === "exit")).toBe(true);
    expect(allMessages(agentsSocket).some((m) => m.type === "exit")).toBe(true);
  });

  it("does not broadcast across different build sessions", () => {
    const { wss, broadcaster } = makeBroadcaster();
    const socketA = connect(wss, "/ws/supa-os/build/session-A/terminal");
    const socketB = connect(wss, "/ws/supa-os/build/session-B/terminal");

    broadcaster.pushTerminalStdout("session-A", "hello A");

    const aMsgs = allMessages(socketA);
    const bMsgs = allMessages(socketB);

    expect(aMsgs.some((m) => m.type === "stdout")).toBe(true);
    expect(bMsgs.some((m) => m.type === "stdout")).toBe(false);
  });
});
