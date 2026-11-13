// Seams between the storage scan service (scan-service.ts, tree.ts, routes.ts)
// and the storage action guard / action routes (guard.ts, action-routes.ts).
// index.ts wires one to the other; neither side imports the other's modules.

import type { StorageNodeActions, StorageNodeKind, StorageNode } from "@orquester/api";

/** What the tree query needs from the guard to annotate the nodes it returns. */
export interface StorageGuardPort {
  /**
   * Action availability for a scanned `dir` or `file` node. Pure path logic on
   * the scanned (already canonical — gdu does not follow symlinks) path: no I/O,
   * so annotating hundreds of nodes per response is cheap. The action routes
   * re-check every request against the real filesystem.
   */
  actionsFor(path: string, kind: Extract<StorageNodeKind, "dir" | "file">): StorageNodeActions;
  /** The project a path is inside, if any (for the UI's "Open in Files"). */
  projectFor(path: string): StorageNode["project"] | undefined;
}

/** What the action routes need from the scan service to keep saved scans in step. */
export interface StorageTreeMutations {
  /**
   * The size the saved scan recorded for `path` (0 when it isn't in any saved
   * scan). Read BEFORE deleting so the response can report it.
   */
  sizeOf(path: string): number;
  /**
   * `path` was deleted: drop it from every saved scan that contains it, subtract
   * its size from each ancestor, persist, and publish storage.changed. A path not
   * in any scan is a no-op.
   */
  applyDelete(path: string): Promise<void>;
  /** `from` was renamed to `to` (same parent): rename the node and every path under it, persist, publish. */
  applyRename(from: string, to: string): Promise<void>;
}
