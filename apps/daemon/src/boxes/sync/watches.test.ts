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
  const calls: string[] = [];
  const keyOf = (boxId: string, scope: BoxSyncScope) => `${boxId}|${scope.agent}|${scope.configRoots.join(",")}`;
  const sync: BoxConfigSync = {
    ensureSynced: async (boxId, scope) => {
      calls.push(`ensureSynced ${keyOf(boxId, scope)}`);
      if (options.failSync) throw new Error("box gone");
    },
    watch: (boxId, scope) => {
      const key = keyOf(boxId, scope);
      watching.set(key, (watching.get(key) ?? 0) + 1);
      return () => watching.set(key, (watching.get(key) ?? 1) - 1);
    },
    turnEnded: async (boxId, threadId) => void calls.push(`turnEnded ${boxId} ${threadId}`),
    turnStarted: (boxId, threadId) => void calls.push(`turnStarted ${boxId} ${threadId}`)
  };
  const live = () => [...watching].filter(([, refs]) => refs > 0).map(([key, refs]) => `${key}x${refs}`);
  return { sync, calls, live };
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
  assert.equal(watches.watched("b1"), 3);
  assert.equal(watches.watched("b3"), 0);

  watches.release("b1");
  assert.deepEqual(live(), ["b2|claude|/h/claudex1"]);
  // Kept again after a release (the plugin back on): a fresh watch.
  watches.keep("b1", { agent: "claude", configRoots: ["/h/claude"] });
  watches.releaseAll();
  assert.deepEqual(live(), []);
  assert.equal(watches.watched("b2"), 0);
});

test("syncing: a successful ensureSynced keeps its scope watched; a failed one does not; turns pass through", async () => {
  const ok = recordingSync();
  const watches = new BoxConfigWatches({ sync: ok.sync, active: () => true });
  const wrapped = watches.syncing(ok.sync);
  await wrapped.ensureSynced("b1", { agent: "grok", configRoots: ["/h/grok", "/p/g1"], threadId: "t1" }, new AbortController().signal);
  assert.deepEqual(ok.live(), ["b1|grok|/h/grok,/p/g1x1"]);
  await wrapped.turnEnded("b1", "t1");
  wrapped.turnStarted?.("b1", "t2");
  assert.deepEqual(ok.calls, ["ensureSynced b1|grok|/h/grok,/p/g1", "turnEnded b1 t1", "turnStarted b1 t2"]);

  const failing = recordingSync({ failSync: true });
  const other = new BoxConfigWatches({ sync: failing.sync, active: () => true });
  await assert.rejects(other.syncing(failing.sync).ensureSynced("b1", { agent: "claude", configRoots: ["/h"], threadId: null }, new AbortController().signal));
  assert.deepEqual(failing.live(), []);
});

test("a watch that cannot start is logged and not held", () => {
  const warnings: string[] = [];
  const sync = recordingSync().sync;
  sync.watch = () => {
    throw new Error("Config roots must be absolute host paths.");
  };
  const watches = new BoxConfigWatches({ sync, active: () => true, logger: { warn: (message) => warnings.push(message) } });
  watches.keep("b1", { agent: "claude", configRoots: ["relative"] });
  assert.equal(watches.watched("b1"), 0);
  assert.equal(warnings.length, 1);
});
