/**
 * Thread store factory — the composition seam W1 (host core) wires in `main.ts`.
 * Package W2 replaces this stub with the real implementation (spec §5.1). Keep the
 * factory name and extend `ThreadStoreOptions` only additively.
 */
import type { Clock, IdGen, ThreadStore } from "../services.ts";

export interface ThreadStoreOptions {
  /** `<appdir>/daemon/agent` — the directory that holds `threads/` and `receipts.json`. */
  rootDir: string;
  clock?: Clock;
  idGen?: IdGen;
}

export function createThreadStore(_options: ThreadStoreOptions): ThreadStore {
  throw new Error("agent-chat: createThreadStore not implemented (package W2)");
}
