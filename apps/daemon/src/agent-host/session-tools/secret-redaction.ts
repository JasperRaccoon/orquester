/**
 * Agent host — keeping session-tool secrets out of everything the host
 * persists (design `2026-10-14-agent-visuals-and-session-tools-design.md` §5
 * "Secrets"; where the value goes: `@orquester/api` `secret-requests.ts`).
 *
 * A tool whose definition names `secretResultKeys` (`request_secret`) hands
 * the agent a value it must use and the thread must never keep. The value
 * reaches the provider through this host, and comes back through it: the
 * provider records the result in its conversation and reports the call, and
 * an agent may repeat the value later (a command line, a message). So before
 * any of a thread's runtime events reaches ingestion — and so `events.ndjson`,
 * the item and tool-output reads, the SQLite index and search, the external
 * `/mcp` transcript — and before any of its frames reaches `raw.ndjson`:
 *
 * - **by value**: every value handed to the thread in this host process is
 *   masked wherever it occurs. Held in memory only, until the thread is
 *   released or the host exits; values shorter than
 *   {@link SECRET_SCRUB_MIN_CHARS} are masked only inside MCP call rows (a
 *   short value masked everywhere would shred the transcript);
 * - **by shape**: `stripSecretRequestValues` drops the value from any
 *   `request_secret` result in an MCP call row or a raw frame — no memory
 *   needed, so it holds across a host restart too.
 */

import {
  SECRET_REDACTED_TEXT,
  stripSecretRequestValues,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

/** Below this, a value is masked only in MCP call rows (see the module doc). */
export const SECRET_SCRUB_MIN_CHARS = 6;

const MAX_DEPTH = 64;

function replaceAll(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) {
      out = out.split(value).join(SECRET_REDACTED_TEXT);
    }
  }
  return out;
}

/** `value` with every occurrence of `values` in its strings masked; the same reference when none occurs. */
export function maskSecretValues<T>(value: T, values: readonly string[]): T {
  if (values.length === 0) return value;
  return mask(value, values, 0) as T;
}

function mask(value: unknown, values: readonly string[], depth: number): unknown {
  if (typeof value === "string") {
    return replaceAll(value, values);
  }
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      const next = mask(entry, values, depth + 1);
      if (next !== entry) {
        out ??= value.slice();
        out[index] = next;
      }
    }
    return out ?? value;
  }
  let out: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = mask(entry, values, depth + 1);
    if (next !== entry) {
      out ??= { ...(value as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return out ?? value;
}

function isMcpCallEvent(event: RuntimeEvent): boolean {
  return (
    (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
    event.payload?.itemType === "mcp_tool_call"
  );
}

export class SessionSecretRedactor {
  private readonly byThread = new Map<string, Set<string>>();

  /** Remember values handed to `threadId` — call BEFORE the provider can see them. */
  remember(threadId: string, values: readonly string[]): void {
    const kept = values.filter((value) => typeof value === "string" && value.length > 0);
    if (kept.length === 0) return;
    let set = this.byThread.get(threadId);
    if (set === undefined) {
      set = new Set();
      this.byThread.set(threadId, set);
    }
    for (const value of kept) set.add(value);
  }

  /** Drop what `threadId` holds (the thread was released or deleted). */
  forget(threadId: string): void {
    this.byThread.delete(threadId);
  }

  /** True while `threadId` has a value to mask (tests). */
  holds(threadId: string): boolean {
    return (this.byThread.get(threadId)?.size ?? 0) > 0;
  }

  private valuesFor(threadId: string, includeShort: boolean): string[] {
    const set = this.byThread.get(threadId);
    if (set === undefined) return [];
    // Longest first, so a value that contains another is masked whole.
    return [...set]
      .filter((value) => includeShort || value.length >= SECRET_SCRUB_MIN_CHARS)
      .sort((a, b) => b.length - a.length);
  }

  /** A runtime event as ingestion may see it. Never throws; the same reference when nothing changed. */
  redactEvent(event: RuntimeEvent): RuntimeEvent {
    try {
      if (event === null || typeof event !== "object" || typeof event.threadId !== "string") {
        return event;
      }
      const mcpCall = isMcpCallEvent(event);
      let out = maskSecretValues(event, this.valuesFor(event.threadId, mcpCall));
      if (mcpCall) {
        out = stripSecretRequestValues(out);
      }
      return out;
    } catch {
      return event;
    }
  }

  /** A provider frame as `raw.ndjson` may keep it. Never throws. */
  redactFrame(threadId: string, frame: unknown): unknown {
    try {
      return stripSecretRequestValues(maskSecretValues(frame, this.valuesFor(threadId, true)));
    } catch {
      return frame;
    }
  }
}
