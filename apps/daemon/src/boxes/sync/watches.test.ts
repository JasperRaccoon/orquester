/**
 * `BoxConfigWatches`: one watch per (box, agent, roots) however often a scope is synced, none for
 * a box that is not active, every watch released with its box (or all at once), and the
 * `syncing` wrapper keeping a scope watched only after its `ensureSynced` succeeded.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoxConfigSync, BoxSyncScope } from "../contracts.ts";
import { BoxConfigWatches } from "./watches.ts";

function recordingSync(options: { failSync?: boolean } = {}) {
  const watching = new Map<string, number>();
  const keyOf = (boxId: string, scope: BoxSyncScope) => `${boxId}|${scope.agent}|${[...new Set(scope.configRoots)].sort().join(",")}`;
  const sync: BoxConfigSync = {
    ensureSynced: async () => {
      if (options.failSync) throw new Error("box gone");
    },
    watch: (boxId, scope) => {
      const key = keyOf(boxId, scope);
      watching.set(key, (watching.get(key) ?? 0) + 1);
      return () => watching.set(key, (watching.get(key) ?? 1) - 1);
    },
    turnEnded: async () => {},
    turnStarted: () => {}
  };
  const live = () => [...watching].filter(([, refs]) => refs > 0).map(([key, refs]) => `${key}x${refs}`);
  return { sync, live };
}

test("keep holds one watch per scope (roots in any order), only for active boxes; release ends a box's watches", () => {
  const { sync, live } = recordingSync();
  const active = new Set(["b1", "b2"]);
  const watches = new BoxConfigWatches({ sync, active: (boxId) => active.has(boxId) });
  watches.keep("b1", { agent: "claude", configRoots: ["/h/claude"] });
  watches.keep("b1", { agent: "claude", configRoots: ["/h/claude"] });
  watches.keep("b1", { agent: "claude", configRoots: ["/p/v1", "/h/claude"] });
  watches.keep("b1", { agent: "claude", configRoots: ["/h/claude", "/p/v1", "/h/claude"] });
  watches.keep("b1", { agent: "codex", configRoots: ["/h/codex"] });
  watches.keep("b1", { agent: "codex", configRoots: [] });
  watches.keep("b2", { agent: "claude", configRoots: ["/h/claude"] });
  watches.keep("b3", { agent: "claude", configRoots: ["/h/claude"] });
  assert.deepEqual(live().sort(), ["b1|claude|/h/claude,/p/v1x1", "b1|claude|/h/claudex1", "b1|codex|/h/codexx1", "b2|claude|/h/claudex1"]);

  watches.release("b1");
  assert.deepEqual(live(), ["b2|claude|/h/claudex1"]);
  // Kept again after a release (the plugin back on): a fresh watch.
  watches.keep("b1", { agent: "claude", configRoots: ["/h/claude"] });
  watches.releaseAll();
  assert.deepEqual(live(), []);
});

test("a failed initial sync does not keep a watch", async () => {
  const failing = recordingSync({ failSync: true });
  const watches = new BoxConfigWatches({ sync: failing.sync, active: () => true });
  await assert.rejects(watches.syncing(failing.sync).ensureSynced("b1", { agent: "claude", configRoots: ["/h"], threadId: null }, new AbortController().signal), /box gone/);
  assert.deepEqual(failing.live(), []);
});

test("a watch that cannot start can be retried", () => {
  const { sync, live } = recordingSync();
  const watch = sync.watch;
  sync.watch = () => { throw new Error("Box disconnected"); };
  const watches = new BoxConfigWatches({ sync, active: () => true });
  const scope = { agent: "claude" as const, configRoots: ["/h/claude"] };
  watches.keep("b1", scope);
  sync.watch = watch;
  watches.keep("b1", scope);
  assert.deepEqual(live(), ["b1|claude|/h/claudex1"]);
  watches.releaseAll();
  assert.deepEqual(live(), []);
});
