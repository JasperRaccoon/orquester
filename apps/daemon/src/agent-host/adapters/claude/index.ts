/**
 * Agent host — the Claude adapter (spec §4.5 Claude).
 *
 * **Stub. Package W6 implements this directory.**
 *
 * Shape of the work: the Agent SDK's `query()` with a streaming input kept
 * open across turns, one `query` per thread;
 * `pathToClaudeCodeExecutable` pointed at the registry-resolved binary so the
 * SDK's bundled copy is never used; `canUseTool` as the whole approval
 * surface; env is `CLAUDE_CONFIG_DIR` only (never `HOME`).
 *
 */

import type { AdapterContext, AdapterFactory, AgentAdapter } from "../../adapter.ts";

export const createClaudeAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  void context;
  throw new Error("agent-chat: claude adapter not implemented (package W6)");
};
