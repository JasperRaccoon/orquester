/**
 * Claude adapter — the injectable seam (spec §9 "runtime-level tests").
 *
 * The Claude transport is the Agent SDK's `query()`, so the analogue of the
 * other adapters' scripted mock peer is an injected `query`. Production wires
 * the real SDK; the lifecycle tests wire a scripted fake that speaks the same
 * `Query` surface — the real adapter, the real normaliser and the real
 * supervision run either way.
 *
 * `spawn` is the same seam for the `--version` probe and the history worker,
 * both of which are genuine child processes through `support/spawn.ts`.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options as ClaudeQueryOptions, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import { spawnProviderChild } from "../../support/spawn.ts";

export type ClaudeQueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeQueryOptions;
}) => Query;

export interface ClaudeAdapterDeps {
  query: ClaudeQueryFactory;
  spawn: typeof spawnProviderChild;
  /** Overridden in tests so no wait is a real wait. */
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimer: (handle: NodeJS.Timeout | number) => void;
  /** `process.env.CLAUDE_CONFIG_DIR`, read once at host start. */
  hostConfigDir: string | undefined;
  /** Node binary used for the history worker. */
  nodePath: string;
  /**
   * Called each time a session's goal transcript work has drained (goals
   * §6.1.4-5). Those reads run off the message loop by design; this is what a
   * test waits on instead of a sleep (§9). Production passes nothing.
   */
  onGoalWorkIdle?: (threadId: string) => void;
  /**
   * Awaited before each goal transcript read (`label` names it: `read`,
   * `restore`, `tail`, `set-point`), outside the read's own deadline. A test
   * parks a read here to hold a teardown open; production passes nothing.
   */
  goalReadGate?: (threadId: string, label: string) => Promise<void>;
  /**
   * Called on every write of a thread's start record — what a lazy recovery
   * or a rewind restarts from — naming the writer. A test asserts no stale
   * session writes it; production passes nothing.
   */
  onStartRecord?: (
    threadId: string,
    writer: "start" | "started" | "send" | "closed" | "rollback"
  ) => void;
  /**
   * The §3.1 windows, so a test asserts an expired deadline's behaviour
   * without waiting one out — §9's "nothing waits on a timer".
   */
  deadlines: {
    handshakeMs: number;
    cancelMs: number;
    compactMs: number;
    contextUsageMs: number;
  };
}

/**
 * A `/compact` turn is an ordinary turn that can legitimately take minutes on a
 * long thread (the capture measured 10.3 s on a small one), so it gets its own
 * window rather than the cancel one — but it is still bounded, because an
 * unbounded wait latches the host's `compacting` flag and silently queues every
 * later message (§3.1 "every step that waits on a child has a deadline").
 */
export const CLAUDE_COMPACT_DEADLINE_MS = 10 * 60_000;

/**
 * `getContextUsage({detail:"summary"})` is answered from the last response's
 * usage and local estimates, with no token-count API call, and measured 650 ms
 * in the capture (fixtures/claude README observation 25). Five seconds is
 * therefore generous — and it is a *refresh of a display*, so an expiry is
 * simply "no better number this time", never a turn failure.
 */
export const CLAUDE_CONTEXT_USAGE_DEADLINE_MS = 5_000;

export function defaultClaudeAdapterDeps(): ClaudeAdapterDeps {
  return {
    query: sdkQuery,
    spawn: spawnProviderChild,
    deadlines: {
      handshakeMs: AGENT_HOST_DEADLINES.handshakeMs,
      cancelMs: AGENT_HOST_DEADLINES.cancelMs,
      compactMs: CLAUDE_COMPACT_DEADLINE_MS,
      contextUsageMs: CLAUDE_CONTEXT_USAGE_DEADLINE_MS
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    },
    hostConfigDir: process.env.CLAUDE_CONFIG_DIR,
    nodePath: process.execPath
  };
}
