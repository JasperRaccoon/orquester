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
   * The §3.1 windows, so a test asserts an expired deadline's behaviour
   * without waiting one out — §9's "nothing waits on a timer".
   */
  deadlines: { handshakeMs: number; cancelMs: number };
}

export function defaultClaudeAdapterDeps(): ClaudeAdapterDeps {
  return {
    query: sdkQuery,
    spawn: spawnProviderChild,
    deadlines: {
      handshakeMs: AGENT_HOST_DEADLINES.handshakeMs,
      cancelMs: AGENT_HOST_DEADLINES.cancelMs
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    },
    hostConfigDir: process.env.CLAUDE_CONFIG_DIR,
    nodePath: process.execPath
  };
}
