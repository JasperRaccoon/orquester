/**
 * Agent host — the Codex adapter (spec §4.5 Codex).
 *
 * **Stub. Package W7 implements this directory.**
 *
 * Shape of the work: one `codex app-server` child per thread speaking NDJSON
 * JSON-RPC over stdio with **no `jsonrpc` field** and a 32 in-flight
 * server-request cap; the method catalog is generated under
 * `_generated/` by package X2.
 *
 */

import type { AdapterContext, AdapterFactory, AgentAdapter } from "../../adapter.ts";

export const createCodexAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  void context;
  throw new Error("agent-chat: codex adapter not implemented (package W7)");
};
