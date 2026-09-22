/**
 * Agent host — the adapter registry (spec §3.2, §4.1).
 *
 * Static `id → AdapterFactory`. Every import is **static, at module load**:
 * §8 forbids a lazy dynamic `import()` anywhere under the host, because a
 * surviving host must never load changed source after a deploy.
 */

import type { AgentAdapterId, ProviderSnapshot } from "@orquester/api/agent-chat";

import type { AdapterFactory } from "../adapter.ts";
import { createClaudeAdapter, pendingClaudeSnapshot } from "./claude/index.ts";
import { createCodexAdapter, pendingCodexSnapshot } from "./codex/index.ts";
import {
  OPENCODE_SNAPSHOT_TIMEOUT_MS,
  createOpenCodeAdapter,
  pendingOpenCodeSnapshot
} from "./opencode/index.ts";
import { createGrokAdapter, pendingGrokSnapshot } from "./grok/index.ts";

export const ADAPTER_FACTORIES: Readonly<Record<AgentAdapterId, AdapterFactory>> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  opencode: createOpenCodeAdapter,
  grok: createGrokAdapter
};

/**
 * The §3.2 PENDING snapshot per adapter, as a **module-level function** rather
 * than a method: the snapshot registry seeds itself at construction, which is
 * before any adapter has been acquired (adapters are built inside the host's
 * `ready` promise, the registry is built before it). Same shape the adapter's
 * own `pendingSnapshot()` returns — the two spellings share one implementation
 * so they cannot drift.
 *
 * *T3: `apps/server/src/provider/makeManagedServerProvider.ts:69-73` —
 * `initialSnapshot(settings)` is likewise an input to the provider's
 * construction, not something read off a built provider.*
 */
export const ADAPTER_PENDING_SNAPSHOTS: Readonly<
  Record<AgentAdapterId, (checkedAt: string) => ProviderSnapshot>
> = {
  claude: pendingClaudeSnapshot,
  codex: pendingCodexSnapshot,
  opencode: pendingOpenCodeSnapshot,
  grok: pendingGrokSnapshot
};

/** Every adapter id, in the order Settings and the launch picker show them. */
export const ADAPTER_IDS: readonly AgentAdapterId[] = [
  "claude",
  "codex",
  "opencode",
  "grok"
] as const;

/**
 * Per-adapter snapshot ceilings, for the probes the default auth window is too
 * short for (E9). Data, not a branch at the call site: an adapter that needs a
 * longer leash says so here and the registry reads it.
 *
 * Only OpenCode does, and only because its catalogue lives behind a
 * per-project `opencode serve` that a cold probe must start first — see
 * {@link OPENCODE_SNAPSHOT_TIMEOUT_MS}.
 */
export const SNAPSHOT_TIMEOUTS_MS: Readonly<Partial<Record<AgentAdapterId, number>>> = {
  opencode: OPENCODE_SNAPSHOT_TIMEOUT_MS
};

export function adapterFactory(id: AgentAdapterId): AdapterFactory {
  return ADAPTER_FACTORIES[id];
}

export function isAgentAdapterId(value: string): value is AgentAdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(value);
}
