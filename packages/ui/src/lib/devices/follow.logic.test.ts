import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { followLeases, followPanel, INITIAL_FOLLOW_STATE, type FollowState } from "./follow.logic.ts";

type L = { id: string; threadId: string; openedBy: "agent" | "user"; state: "starting" | "ready" | "lost" | "suspended" | "released" };
const l = (id: string, overrides: Partial<L> = {}): L => ({ id, threadId: "chat", openedBy: "agent", state: "starting", ...overrides });
const ctx: { visibleThreadId: string | null; follow: boolean } = { visibleThreadId: "chat", follow: true };

function run(state: FollowState, leases: L[] | null, context = ctx) {
  return followLeases(state, leases, context);
}

describe("follow the agent", () => {
  it("the first list is the baseline: a reload never reopens a device", () => {
    const first = run(INITIAL_FOLLOW_STATE, [l("a")]);
    assert.equal(first.open, null);
    assert.equal(first.state.baselined, true);
    assert.equal(run(first.state, [l("a")]).open, null);
  });
  it("an agent opening a device for the visible chat opens the panel on it", () => {
    const base = run(INITIAL_FOLLOW_STATE, []).state;
    assert.deepEqual(run(base, [l("a")]).open, { threadId: "chat", leaseId: "a" });
  });
  it("not for another chat, a user-opened device, a lost one, or with the setting off", () => {
    const base = run(INITIAL_FOLLOW_STATE, []).state;
    assert.equal(run(base, [l("a", { threadId: "other" })]).open, null);
    assert.equal(run(base, [l("a", { openedBy: "user" })]).open, null);
    assert.equal(run(base, [l("a", { state: "lost" })]).open, null);
    assert.equal(run(base, [l("a")], { ...ctx, follow: false }).open, null);
    assert.equal(run(base, [l("a")], { ...ctx, visibleThreadId: null }).open, null);
  });
  it("a lease seen once never opens again (it was seen while another chat showed)", () => {
    const base = run(INITIAL_FOLLOW_STATE, []).state;
    const elsewhere = run(base, [l("a")], { ...ctx, visibleThreadId: "other" }).state;
    assert.equal(run(elsewhere, [l("a", { state: "ready" })]).open, null);
  });
  it("closing the panel on a chat with a device dismisses that chat for the session; showing it again forgets that", () => {
    let state = run(INITIAL_FOLLOW_STATE, []).state;
    assert.equal(followPanel(state, "chat", false, false), state, "closing an empty panel dismisses nothing");
    state = followPanel(state, "chat", false, true);
    assert.equal(run(state, [l("a")]).open, null);
    state = run(state, [l("a")]).state;
    state = followPanel(state, "chat", true, true);
    assert.deepEqual(run(state, [l("a"), l("b")]).open, { threadId: "chat", leaseId: "b" });
    assert.equal(followPanel(state, null, false, true), state);
  });
  it("the newest new lease wins, and a reset (null) takes a new baseline", () => {
    const base = run(INITIAL_FOLLOW_STATE, []).state;
    assert.deepEqual(run(base, [l("a"), l("b")]).open, { threadId: "chat", leaseId: "b" });
    const reset = run(base, null).state;
    assert.equal(reset.baselined, false);
    assert.equal(run(reset, [l("z")]).open, null, "the list after a reconnect is a baseline again");
  });
});
