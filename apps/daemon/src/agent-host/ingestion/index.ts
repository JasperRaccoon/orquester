/**
 * Ingestion factory — the composition seam W1 (host core) wires in `main.ts`.
 * Package W3 replaces this stub with the real implementation (spec §5.1 ingestion
 * rules, §5.6 batching). Keep the factory name and extend `IngestionOptions` only
 * additively.
 */
import type { AppendableDomainEvent, Clock, IdGen, Ingestion, LivenessRegistry } from "../services.ts";

export interface IngestionOptions {
  /** Where translated domain events go — W1 appends them through the store, in order, per thread. */
  sink: (threadId: string, events: AppendableDomainEvent[]) => Promise<void>;
  /** Fed on every task transition (§3.1 background liveness). */
  liveness: LivenessRegistry;
  clock?: Clock;
  idGen?: IdGen;
  /** Injectable timers so batching is testable without sleeping (§9). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createIngestion(_options: IngestionOptions): Ingestion {
  throw new Error("agent-chat: createIngestion not implemented (package W3)");
}
