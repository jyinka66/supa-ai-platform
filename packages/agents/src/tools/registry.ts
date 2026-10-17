// Tool registry — the lookup table the executor uses to resolve a tool id
// to its ToolDef (schema, permission, class, timeout, executor).
//
// Tools are registered at boot (server / app init), NOT per-run. The
// registry is process-wide and read-only after boot — registering at runtime
// would be a race. The registry is the single source of truth for "what
// tools exist"; the agent's `toolGrants` reference tool ids that must exist
// here (or the agent is misconfigured and won't start).

import type { ToolDef } from "../permissions.js";

class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  /** Register a tool. Throws on duplicate id (registry is boot-time only). */
  register(tool: ToolDef): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`tool_already_registered:${tool.id}`);
    }
    this.tools.set(tool.id, tool);
  }

  /** Look up a tool by id. Returns undefined if not registered. */
  get(id: string): ToolDef | undefined {
    return this.tools.get(id);
  }

  /** List all registered tools (for admin UI + grant validation). */
  list(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  /** Clear (tests only). */
  clear(): void {
    this.tools.clear();
  }
}

/** Singleton registry — process-wide. Boot-time writes, runtime reads. */
export const registry = new ToolRegistry();
