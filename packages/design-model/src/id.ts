// ULID: sortable, no crypto-random-in-content violations (ids are structure,
// not content — deterministic re-creation of a doc from a command replay
// requires seeded ids; command payloads therefore always carry explicit ids).
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

/**
 * Generates a new monotonic ULID for a node, page, or asset.
 *
 * ULIDs are:
 *   - Sortable (by timestamp) — layers in a list stay ordered by creation
 *   - 26 chars (vs UUID's 36) — smaller in storage + URL
 *   - Case-insensitive — safe in URLs
 *   - Monotonic — guaranteed unique within the same millisecond
 *
 * The monotonic factory ensures that even if two IDs are generated within
 * the same millisecond, they're still sortable by creation order.
 *
 * IDs are STRUCTURE (not content) — they don't violate the "no
 * nondeterminism" rule because command payloads always carry explicit IDs.
 * This means a command replay (e.g. for collaboration or undo) produces
 * the same IDs every time.
 */
export const newId = (): string => ulid();
