/**
 * Checkpoint service factory — the composition seam W1 (host core) wires in `main.ts`.
 * Package W4 replaces this stub with the real implementation (spec §5.4, §5.5). Keep
 * the factory name and extend `CheckpointServiceOptions` only additively.
 */
import type { CheckpointService, Clock } from "../services.ts";

export interface CheckpointServiceOptions {
  clock?: Clock;
  /** Explicit env for every `git` child (§3.1) — never `process.env`. */
  gitEnv: Record<string, string>;
  /** Host-wide permit count for concurrent git work (§5.4). */
  maxConcurrentGit?: number;
}

export function createCheckpointService(_options: CheckpointServiceOptions): CheckpointService {
  throw new Error("agent-chat: createCheckpointService not implemented (package W4)");
}
