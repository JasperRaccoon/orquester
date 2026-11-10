import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edge, node, workflow } from "../../../lib/workflows/testing.ts";
import { reduceTapConnect, TAP_CONNECT_IDLE, type TapConnectState } from "./tap-connect.ts";

const wf = () =>
  workflow(
    [
      node("t", "trigger.manual", {}, { name: "Start" }),
      node("a", "agent", {}, { name: "Review" }),
      node("b", "code", {}, { name: "Report" }),
      node("s", "stop", {}, { name: "Stop" })
    ],
    [edge("t", "a"), edge("a", "b")]
  );

describe("tap-to-connect", () => {
  it("start → tap a block: connects, back to idle", () => {
    const started = reduceTapConnect(TAP_CONNECT_IDLE, { type: "start", from: { nodeId: "a", handle: "error" } }, wf());
    assert.equal(started.state.mode, "picking");
    assert.equal(started.connect, null);
    const done = reduceTapConnect(started.state, { type: "tap-node", nodeId: "s" }, wf());
    assert.deepEqual(done.connect, { source: "a", sourceHandle: "error", target: "s" });
    assert.deepEqual(done.state, TAP_CONNECT_IDLE);
  });

  it("a refused target keeps picking and says why", () => {
    // A failure output may not loop back to Review, which runs before it.
    const picking: TapConnectState = { mode: "picking", from: { nodeId: "b", handle: "error" }, refusal: null };
    const loop = reduceTapConnect(picking, { type: "tap-node", nodeId: "a" }, wf());
    assert.equal(loop.connect, null);
    assert.equal(loop.state.mode, "picking");
    assert.ok(loop.state.mode === "picking" && /failure output cannot loop back/.test(loop.state.refusal ?? ""));
    const trigger = reduceTapConnect(loop.state, { type: "tap-node", nodeId: "t" }, wf());
    assert.ok(trigger.state.mode === "picking" && /cannot go back to a trigger/.test(trigger.state.refusal ?? ""));
    const ok = reduceTapConnect(trigger.state, { type: "tap-node", nodeId: "s" }, wf());
    assert.deepEqual(ok.connect, { source: "b", sourceHandle: "error", target: "s" });
  });

  it("tapping a block that runs before connects a loop back to it (spec 2026-11-10 §7.1)", () => {
    const picking: TapConnectState = { mode: "picking", from: { nodeId: "b", handle: "success" }, refusal: null };
    const loop = reduceTapConnect(picking, { type: "tap-node", nodeId: "a" }, wf());
    assert.deepEqual(loop.connect, { source: "b", sourceHandle: "success", target: "a" });
    assert.deepEqual(loop.state, TAP_CONNECT_IDLE);
  });

  it("its own block or Cancel ends it; a tap while idle does nothing; a new start replaces", () => {
    const picking: TapConnectState = { mode: "picking", from: { nodeId: "a", handle: "success" }, refusal: "x" };
    assert.deepEqual(reduceTapConnect(picking, { type: "tap-node", nodeId: "a" }, wf()).state, TAP_CONNECT_IDLE);
    assert.deepEqual(reduceTapConnect(picking, { type: "cancel" }, wf()).state, TAP_CONNECT_IDLE);
    assert.deepEqual(reduceTapConnect(TAP_CONNECT_IDLE, { type: "tap-node", nodeId: "a" }, wf()), { state: TAP_CONNECT_IDLE, connect: null });
    const again = reduceTapConnect(picking, { type: "start", from: { nodeId: "b", handle: "error" } }, wf());
    assert.deepEqual(again.state, { mode: "picking", from: { nodeId: "b", handle: "error" }, refusal: null });
  });
});
