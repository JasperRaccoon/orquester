/**
 * Agent host — the adapter registry (spec §3.2, §4.1).
 *
 * Static `id → AdapterFactory`. Every import is **static, at module load**:
 * §8 forbids a lazy dynamic `import()` anywhere under the host, because a
 * surviving host must never load changed source after a deploy.
 */

import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { AdapterFactory } from "../adapter.ts";
import { createClaudeAdapter } from "./claude/index.ts";
import { createCodexAdapter } from "./codex/index.ts";
import { createOpenCodeAdapter } from "./opencode/index.ts";
import { createGrokAdapter } from "./grok/index.ts";

export const ADAPTER_FACTORIES: Readonly<Record<AgentAdapterId, AdapterFactory>> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  opencode: createOpenCodeAdapter,
  grok: createGrokAdapter
};

/** Every adapter id, in the order Settings and the launch picker show them. */
export const ADAPTER_IDS: readonly AgentAdapterId[] = [
  "claude",
  "codex",
  "opencode",
  "grok"
] as const;

export function adapterFactory(id: AgentAdapterId): AdapterFactory {
  return ADAPTER_FACTORIES[id];
}

export function isAgentAdapterId(value: string): value is AgentAdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(value);
}
