/**
 * The standing config watches of project boxes (spec §8.3): a box's agent config stays equal to
 * the host's for as long as the box lives, not only at a CLI launch or a turn end. Every scope a
 * box was synced with (each managed account home at setup, each chat's account home plus its
 * Agent Profile's prepared dir at launch) is kept under `BoxConfigSync.watch` — host edits reach
 * the box within the sync's debounce, box edits become change sets, and every reconnect runs a
 * full pass — until the box is destroyed or the plugin is turned off.
 *
 * Watches are held per (box, agent, roots), once each; {@link BoxConfigWatches.syncing} wraps a
 * `BoxConfigSync` so that every successful `ensureSynced` keeps its scope watched.
 */

import type { BoxConfigSync, BoxSyncScope } from "../contracts.ts";

export interface BoxConfigWatchesOptions {
  sync: Pick<BoxConfigSync, "watch">;
  /** Whether a box's config is kept in sync now (the plugin is on and it is a live project box). */
  active: (boxId: string) => boolean;
  logger?: { warn?: (message: string) => void };
}

export class BoxConfigWatches {
  /** Box id → scope key → the watch's release. */
  private readonly held = new Map<string, Map<string, () => void>>();

  constructor(private readonly options: BoxConfigWatchesOptions) {}

  /** Keep a scope of a box watched (idempotent); nothing for a box that is not {@link BoxConfigWatchesOptions.active}. */
  keep(boxId: string, scope: Pick<BoxSyncScope, "agent" | "configRoots">): void {
    const roots = [...new Set(scope.configRoots.filter((root) => root.length > 0))].sort();
    if (roots.length === 0 || !this.options.active(boxId)) return;
    const key = [scope.agent, ...roots].join("\n");
    let scopes = this.held.get(boxId);
    if (scopes?.has(key)) return;
    let release: () => void;
    try {
      release = this.options.sync.watch(boxId, { agent: scope.agent, configRoots: roots, threadId: null });
    } catch (error) {
      this.options.logger?.warn?.(`box sync (${boxId}): could not watch a config scope: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!scopes) {
      scopes = new Map();
      this.held.set(boxId, scopes);
    }
    scopes.set(key, release);
  }

  /** Stop every watch of a box (its destroy). */
  release(boxId: string): void {
    const scopes = this.held.get(boxId);
    if (!scopes) return;
    this.held.delete(boxId);
    for (const release of scopes.values()) release();
  }

  /** Stop every watch (the plugin was turned off, the daemon stops). */
  releaseAll(): void {
    for (const boxId of [...this.held.keys()]) this.release(boxId);
  }

  /** How many scopes of a box are watched (tests, diagnostics). */
  watched(boxId: string): number {
    return this.held.get(boxId)?.size ?? 0;
  }

  /** `sync` with every successful `ensureSynced` also keeping its scope watched. */
  syncing(sync: BoxConfigSync): BoxConfigSync {
    const wrapped: BoxConfigSync = {
      ensureSynced: async (boxId, scope, signal) => {
        await sync.ensureSynced(boxId, scope, signal);
        this.keep(boxId, scope);
      },
      watch: (boxId, scope) => sync.watch(boxId, scope),
      turnEnded: (boxId, threadId) => sync.turnEnded(boxId, threadId)
    };
    if (sync.turnStarted) {
      const turnStarted = sync.turnStarted.bind(sync);
      wrapped.turnStarted = (boxId, threadId) => turnStarted(boxId, threadId);
    }
    return wrapped;
  }
}
