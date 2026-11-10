// Messages between `voxl-client.ts` and its decode worker (`voxl.worker.ts`).

import type { VoxlConnectionEvent } from "./connection";

/** Page → worker. */
export type VoxlToWorker =
  | { t: "init"; url: string; canvas: OffscreenCanvas }
  | { t: "send"; d: string }
  | { t: "video"; on: boolean }
  | { t: "close" };

/** Worker → page: `ready` once the module has loaded (the page transfers the canvas only then). */
export type VoxlFromWorker = { t: "ready" } | VoxlConnectionEvent;
