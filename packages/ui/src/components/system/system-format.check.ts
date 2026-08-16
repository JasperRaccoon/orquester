import assert from "node:assert/strict";
import type { SystemProcessInfo } from "@orquester/api";
import {
  barWidth,
  buildProcessTree,
  countProcessNodes,
  formatBytes,
  formatPercent,
  killErrorCode,
  killErrorMessage,
  processLabel,
  subtreePids
} from "./system-format";

// Unknown (null) must never render as a real zero — that is the whole point of
// the daemon nulling an unmeasurable volume.
assert.equal(formatBytes(null), "—");
assert.equal(formatBytes(undefined), "—");
assert.equal(formatBytes(Number.NaN), "—");
assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(512), "512 B");
assert.equal(formatBytes(1024), "1.0 KB");
assert.equal(formatBytes(1536), "1.5 KB");
assert.equal(formatBytes(20 * 1024 * 1024), "20 MB");
assert.equal(formatBytes(1024 ** 3 * 1.5), "1.5 GB");
assert.equal(formatBytes(-5), "0 B");

assert.equal(formatPercent(null), "—");
assert.equal(formatPercent(0), "0%");
assert.equal(formatPercent(0.4), "0%");
assert.equal(formatPercent(99.6), "100%");
assert.equal(formatPercent(140), "100%");
assert.equal(formatPercent(-3), "0%");

assert.equal(barWidth(null), "0%");
assert.equal(barWidth(0), "0%");
assert.equal(barWidth(42.5), "42.5%");
assert.equal(barWidth(180), "100%");

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

assert.deepEqual(buildProcessTree([]), []);
assert.equal(countProcessNodes([]), 0);

// Refusal codes are read off the ApiError body, duck-typed.
assert.equal(killErrorCode({ body: { code: "PROCESS_PROTECTED" } }), "PROCESS_PROTECTED");
assert.equal(killErrorCode({ body: { code: "PROCESS_NOT_MANAGED" } }), "PROCESS_NOT_MANAGED");
assert.equal(killErrorCode({ body: { code: "INVALID_PID" } }), "INVALID_PID");
assert.equal(killErrorCode({ body: { code: "UNSUPPORTED_PLATFORM" } }), "UNSUPPORTED_PLATFORM");
assert.equal(killErrorCode({ body: { code: "SOMETHING_ELSE" } }), null);
assert.equal(killErrorCode(new Error("network down")), null);
assert.equal(killErrorCode(null), null);
assert.equal(killErrorCode(undefined), null);

// Every refusal reason reads differently — the point of the discriminated code.
const label = processLabel(proc(21, 20));
assert.equal(label, "p21 (PID 21)");
const messages = (["PROCESS_PROTECTED", "PROCESS_NOT_MANAGED", "INVALID_PID", "UNSUPPORTED_PLATFORM", null] as const).map(
  (code) => killErrorMessage(code, label)
);
assert.equal(new Set(messages).size, messages.length);
assert.match(messages[0], /protected/);
assert.match(messages[1], /no longer/);
assert.match(messages[3], /Linux/);
assert.match(messages[4], /Could not stop p21/);

console.log("system-format.check.ts OK");
