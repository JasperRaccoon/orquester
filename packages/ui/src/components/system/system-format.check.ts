import assert from "node:assert/strict";
import type { SystemProcessInfo } from "@orquester/api";
import { buildProcessTree, countProcessNodes, killErrorCode, subtreePids } from "./system-format";

const proc = (pid: number, ppid: number, extra: Partial<SystemProcessInfo> = {}): SystemProcessInfo => ({
  pid,
  ppid,
  name: `p${pid}`,
  cmdline: `p${pid} --run`,
  rssBytes: 1000,
  ...extra
});

// Daemon (10) + a tmux pane (20, whose real parent 7 is the tmux server and is
// deliberately absent from the list) are both roots of the returned forest.
const tree = buildProcessTree([
  proc(10, 1),
  proc(11, 10),
  proc(12, 11),
  proc(20, 7, { sessionId: "s1" }),
  proc(21, 20, { sessionId: "s1", rssBytes: 4000 })
]);
assert.deepEqual(
  tree.map((n) => n.proc.pid),
  [10, 20]
);
assert.deepEqual(tree[0].children.map((n) => n.proc.pid), [11]);
assert.deepEqual(tree[0].children[0].children.map((n) => n.proc.pid), [12]);
assert.equal(countProcessNodes(tree), 5);
// Subtree RSS rolls up: 10 + 11 + 12 = 3000, pane 20 + 21 = 5000.
assert.equal(tree[0].subtreeRssBytes, 3000);
assert.equal(tree[1].subtreeRssBytes, 5000);
assert.deepEqual(subtreePids(tree[0]), [10, 11, 12]);
assert.deepEqual(subtreePids(tree[1]), [20, 21]);

// A pid recycled into a ppid cycle must not produce an infinitely deep tree.
const cyclic = buildProcessTree([proc(30, 31), proc(31, 30)]);
assert.equal(countProcessNodes(cyclic), 2);
assert.equal(cyclic.length + cyclic[0].children.length, 2);
// Self-parenting (pid 1 style) is a root, never its own child.
const selfParent = buildProcessTree([proc(40, 40)]);
assert.deepEqual(selfParent.map((n) => n.proc.pid), [40]);
assert.equal(selfParent[0].children.length, 0);

// Refusal codes are read off the ApiError body, duck-typed.
assert.equal(killErrorCode({ body: { code: "PROCESS_PROTECTED" } }), "PROCESS_PROTECTED");
assert.equal(killErrorCode({ body: { code: "PROCESS_NOT_MANAGED" } }), "PROCESS_NOT_MANAGED");
assert.equal(killErrorCode({ body: { code: "INVALID_PID" } }), "INVALID_PID");
assert.equal(killErrorCode({ body: { code: "UNSUPPORTED_PLATFORM" } }), "UNSUPPORTED_PLATFORM");
assert.equal(killErrorCode({ body: { code: "SOMETHING_ELSE" } }), null);
assert.equal(killErrorCode(new Error("network down")), null);
assert.equal(killErrorCode(null), null);
assert.equal(killErrorCode(undefined), null);

console.log("system-format.check.ts OK");
