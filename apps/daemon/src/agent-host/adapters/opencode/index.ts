/**
 * Agent host — the OpenCode adapter (spec §4.5 OpenCode).
 *
 * **Stub. Package W8 implements this directory.**
 *
 * Shape of the work: one `opencode serve` **per project**, shared by its
 * threads, over HTTP + SSE. Two invariants make sharing safe (§3.2): chat
 * sessions register nothing thread-scoped into the server, and an automatic
 * approval is a one-shot `once` grant, never a persisted `always`.
 *
 */

import type { AdapterContext, AdapterFactory, AgentAdapter } from "../../adapter.ts";

export const createOpenCodeAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  void context;
  throw new Error("agent-chat: opencode adapter not implemented (package W8)");
};
