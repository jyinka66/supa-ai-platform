// Realtime presence + broadcast — in-memory per-gateway-node map + Redis pub/sub.
//
// Presence states: active | idle (5 min no activity) | offline (socket closed).
// Heartbeat: client ping every 30s; missed 2 pings → idle; socket closed → offline.
//
//   PresenceTracker — per-node in-memory map of userId → presence state.
//     Tracks active websockets, last-seen timestamps, idle transitions.
//     Missed 2 heartbeats (60s) → idle. Socket close → offline.
//
//   broadcast(wsId, evt) — fan-out to all active members of the workspace
//     across all gateway nodes. Uses Redis pub/sub for cross-node delivery.
//     Active members are cached for 30s (avoids querying the DB on every event).
//     Echo: actors never receive their own writes unless echo=true.
//
// Event envelope: { id, ws_id, type, actor_id, payload, ts }.
// The event id is a UUID — enables dedup (if the same event is delivered
// twice via a Redis reconnect, the client can dedup by id).

import { db } from "@supa/db";
import { memberships } from "@supa/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type PresenceState = "active" | "idle" | "offline";

export interface PresenceEntry {
  userId: string;
  wsId: string;
  state: PresenceState;
  lastSeenAt: number; // epoch ms.
  nodeId: string; // which gateway node hosts this connection.
  socketId?: string; // the websocket id (for direct delivery).
}

export interface RealtimeEvent {
  id: string; // UUID — enables client-side dedup.
  wsId: string;
  type: string; // e.g. "file.uploaded", "member.joined", "chat.message".
  actorId: string;
  payload: Record<string, unknown>;
  ts: string; // ISO timestamp.
  echo?: boolean; // if false (default), the actor doesn't receive their own event.
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000; // client pings every 30s.
const IDLE_THRESHOLD_MS = 60_000; // 2 missed heartbeats (60s) → idle.
const OFFLINE_GRACE_MS = 5_000; // grace period after socket close before offline.
const ACTIVE_MEMBERS_CACHE_TTL_MS = 30_000; // cache active members for 30s.

// ───────────────────────────────────────────────
// PresenceTracker — per-node in-memory presence map
// ───────────────────────────────────────────────

/**
 * Per-gateway-node presence tracker. Tracks which users are connected
 * to THIS node (via websockets), their presence state, and their last
 * heartbeat timestamp.
 *
 * Idle/offline transitions are timer-based:
 *   - 2 missed heartbeats (60s without a ping) → idle.
 *   - Socket close → offline (after a 5s grace period to allow reconnect).
 *
 * Cross-node presence is synchronized via Redis pub/sub (other nodes
 * broadcast presence changes to this node).
 */
export class PresenceTracker {
  private readonly entries = new Map<string, PresenceEntry>(); // key: `${wsId}:${userId}`
  private readonly nodeId: string;

  constructor(nodeId: string = randomUUID()) {
    this.nodeId = nodeId;
  }

  /** Get this node's id. */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Register a user as active on this node. Called when a websocket connects.
   */
  setActive(userId: string, wsId: string, socketId?: string): void {
    const key = `${wsId}:${userId}`;
    this.entries.set(key, {
      userId,
      wsId,
      state: "active",
      lastSeenAt: Date.now(),
      nodeId: this.nodeId,
      ...(socketId ? { socketId } : {}),
    });
  }

  /**
   * Record a heartbeat (client ping). Resets the idle timer.
   */
  heartbeat(userId: string, wsId: string): void {
    const key = `${wsId}:${userId}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastSeenAt = Date.now();
      if (entry.state === "idle") {
        entry.state = "active"; // user returned from idle.
      }
    }
  }

  /**
   * Mark a user as offline. Called when a websocket closes.
   * The user goes to offline immediately (after the grace period, the
   * entry is removed).
   */
  setOffline(userId: string, wsId: string): void {
    const key = `${wsId}:${userId}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.state = "offline";
      // Remove after grace period (allows quick reconnect without losing presence).
      setTimeout(() => {
        const current = this.entries.get(key);
        if (current?.state === "offline") {
          this.entries.delete(key);
        }
      }, OFFLINE_GRACE_MS);
    }
  }

  /**
   * Sweep idle users. Called periodically (every 30s) by the heartbeat sweeper.
   * Users who haven't pinged in 60s → idle. Users who haven't pinged in 120s → offline.
   */
  sweepIdle(): PresenceEntry[] {
    const now = Date.now();
    const transitions: PresenceEntry[] = [];

    for (const [key, entry] of this.entries) {
      const elapsed = now - entry.lastSeenAt;

      if (entry.state === "active" && elapsed > IDLE_THRESHOLD_MS) {
        entry.state = "idle";
        transitions.push({ ...entry });
      } else if (entry.state === "idle" && elapsed > IDLE_THRESHOLD_MS * 2) {
        // 120s without heartbeat → offline.
        entry.state = "offline";
        transitions.push({ ...entry });
        // Remove after grace period.
        setTimeout(() => {
          if (this.entries.get(key)?.state === "offline") {
            this.entries.delete(key);
          }
        }, OFFLINE_GRACE_MS);
      }
    }

    return transitions;
  }

  /**
   * Get all active/idle users for a workspace on THIS node.
   * Does NOT include users on other nodes (use `getPresence` for cross-node).
   */
  getLocalPresence(wsId: string): PresenceEntry[] {
    const result: PresenceEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.wsId === wsId && entry.state !== "offline") {
        result.push({ ...entry });
      }
    }
    return result;
  }

  /**
   * Check if a user is active on this node.
   */
  isActive(userId: string, wsId: string): boolean {
    const key = `${wsId}:${userId}`;
    const entry = this.entries.get(key);
    return entry?.state === "active";
  }

  /**
   * Get the number of connected users on this node.
   */
  get connectionCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== "offline") count++;
    }
    return count;
  }
}

// ───────────────────────────────────────────────
// Singleton tracker (per node)
// ───────────────────────────────────────────────

const NODE_ID = process.env.NODE_ID ?? randomUUID();
export const presenceTracker = new PresenceTracker(NODE_ID);

// ───────────────────────────────────────────────
// Active members cache (avoids querying DB on every broadcast)
// ───────────────────────────────────────────────

const activeMembersCache = new Map<string, { members: string[]; cachedAt: number }>();

/**
 * Get the active member user IDs for a workspace. Cached for 30s.
 * Returns only users with status='active' in the memberships table.
 */
export async function activeMembers(wsId: string): Promise<string[]> {
  const cached = activeMembersCache.get(wsId);
  if (cached && Date.now() - cached.cachedAt < ACTIVE_MEMBERS_CACHE_TTL_MS) {
    return cached.members;
  }

  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.wsId, wsId as any),
        eq(memberships.status, "active"),
      ),
    );

  const members = rows.map((r) => r.userId as string);
  activeMembersCache.set(wsId, { members, cachedAt: Date.now() });
  return members;
}

// ───────────────────────────────────────────────
// Redis pub/sub — cross-node broadcast
// ───────────────────────────────────────────────

/**
 * Redis client (stub — production uses `ioredis` or `@upstash/redis`).
 *
 * The pub/sub pattern:
 *   - `publish(channel, message)` — broadcast to all subscribers.
 *   - `subscribe(channel, handler)` — receive messages on a channel.
 *
 * Channel naming: `rt:<nodeId>` — each gateway node subscribes to its own
 * channel. `broadcast` publishes to all nodes that host active members of
 * the workspace.
 */
interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
}

// Stub Redis (in-memory — production swaps to ioredis/@upstash).
const redisSubscribers = new Map<string, ((message: string) => void)[]>();

const redis: RedisLike = {
  async publish(channel: string, message: string): Promise<number> {
    const handlers = redisSubscribers.get(channel) ?? [];
    for (const handler of handlers) {
      handler(message);
    }
    return handlers.length;
  },
  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    const handlers = redisSubscribers.get(channel) ?? [];
    handlers.push(handler);
    redisSubscribers.set(channel, handlers);
  },
};

/**
 * Find which gateway nodes are hosting active connections for a workspace.
 * In a single-node deployment, this is always [NODE_ID].
 * In a multi-node deployment, this queries Redis (or a shared store) for
 * which nodes have active websocket connections for the workspace.
 *
 * Stub — returns [NODE_ID] (single-node). Production would query a Redis
 * set `ws_nodes:<wsId>` maintained by each node on connect/disconnect.
 */
function nodesHosting(_wsId: string): string[] {
  return [NODE_ID];
}

// ───────────────────────────────────────────────
// broadcast — fan-out to all active members across all nodes
// ───────────────────────────────────────────────

/**
 * Broadcast a realtime event to all active members of a workspace.
 *
 * The event is published via Redis pub/sub to all gateway nodes that host
 * active connections for the workspace. Each node delivers the event to
 * its local websockets.
 *
 * Echo: by default, the actor (the user who triggered the event) does NOT
 * receive their own event. Set `echo: true` in the event to echo it back
 * to the actor (useful for optimistic UI reconciliation).
 *
 * The event envelope: { id, ws_id, type, actor_id, payload, ts, echo }.
 * The id is a UUID — enables client-side dedup (if the same event is
 * delivered twice via a Redis reconnect, the client can dedup by id).
 *
 * USAGE:
 *   ```
 *   await broadcast(wsId, {
 *     id: randomUUID(),
 *     wsId,
 *     type: "file.uploaded",
 *     actorId: uid,
 *     payload: { fileId, name, size },
 *     ts: new Date().toISOString(),
 *   });
 *   ```
 */
export async function broadcast(wsId: string, evt: RealtimeEvent): Promise<void> {
  const recipients = await activeMembers(wsId);
  const nodes = nodesHosting(wsId);

  // Build the envelope.
  const envelope = JSON.stringify({
    id: evt.id,
    ws_id: wsId,
    type: evt.type,
    actor_id: evt.actorId,
    payload: evt.payload,
    ts: evt.ts,
    echo: evt.echo ?? false,
    // Include the recipients list so each node can filter (only deliver to
    // active members who are connected on that node).
    recipients,
  });

  // Publish to each hosting node.
  for (const node of nodes) {
    await redis.publish(`rt:${node}`, envelope);
  }
}

/**
 * Subscribe to realtime events on this node. Called once at boot.
 * Each websocket connection registers its own handler (filtered by wsId + userId).
 *
 * The handler receives the raw envelope + decides whether to deliver to
 * the connected websocket (based on wsId match + echo flag + recipient list).
 */
export async function subscribeToRealtime(
  handler: (envelope: {
    id: string;
    ws_id: string;
    type: string;
    actor_id: string;
    payload: Record<string, unknown>;
    ts: string;
    echo: boolean;
    recipients: string[];
  }) => void,
): Promise<void> {
  await redis.subscribe(`rt:${NODE_ID}`, (message: string) => {
    try {
      const envelope = JSON.parse(message);
      handler(envelope);
    } catch {
      // Malformed message — ignore.
    }
  });
}

/**
 * Create a realtime event envelope (helper for callers).
 */
export function createEvent(
  wsId: string,
  type: string,
  actorId: string,
  payload: Record<string, unknown>,
  echo?: boolean,
): RealtimeEvent {
  return {
    id: randomUUID(),
    wsId,
    type,
    actorId,
    payload,
    ts: new Date().toISOString(),
    ...(echo ? { echo } : {}),
  };
}

// ───────────────────────────────────────────────
// Heartbeat sweeper — periodic idle/offline sweep
// ───────────────────────────────────────────────

let sweeperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat sweeper. Runs every 30s, transitions users to
 * idle/offline based on last-seen timestamps. Called once at boot.
 */
export function startHeartbeatSweeper(): void {
  if (sweeperInterval) return; // already running.
  sweeperInterval = setInterval(() => {
    const transitions = presenceTracker.sweepIdle();
    for (const transition of transitions) {
      // Broadcast the presence change to other users in the workspace.
      broadcast(transition.wsId, createEvent(
        transition.wsId,
        "presence.changed",
        transition.userId,
        { userId: transition.userId, state: transition.state },
      )).catch(() => {}); // best-effort.
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat sweeper. Called on graceful shutdown.
 */
export function stopHeartbeatSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}
