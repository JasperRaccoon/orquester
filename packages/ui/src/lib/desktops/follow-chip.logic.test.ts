import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopActionEntry, DesktopActor, DesktopControl } from "@orquester/api";

import { desktopFollowChip, followedStints, type FollowChipContext, type FollowChipDesktop } from "./follow-chip.logic.ts";

const chat = (threadId: string): DesktopActor => ({ kind: "chat", threadId, label: "Claude" });
const agent = (actor?: DesktopActor, since = "2026-11-10T10:00:00.000Z"): DesktopControl => ({ controller: "agent", since, ...(actor ? { actor } : {}) });
const desktop = (control: DesktopControl | null, overrides: Partial<FollowChipDesktop> = {}): FollowChipDesktop => ({
  id: "d1",
  title: "Firefox",
  projectPath: "/w/p",
  control,
  ...overrides
});

function chip(desktops: FollowChipDesktop[], overrides: Partial<FollowChipContext> = {}) {
  return desktopFollowChip({
    threadId: "t1",
    desktops,
    latestAction: () => undefined,
    tabShown: () => false,
    dismissed: new Set(),
    ...overrides
  });
}

describe("follow chip", () => {
  it("shows while this chat's agent controls a desktop the user is not looking at", () => {
    const shown = chip([desktop(agent(chat("t1")))]);
    assert.equal(shown?.desktopId, "d1");
    assert.match(shown!.text, /Claude.*Firefox/);
  });

  it("never for another chat's agent, an external client, the user's control, or nobody's", () => {
    assert.equal(chip([desktop(agent(chat("t2")))]), null);
    assert.equal(chip([desktop(agent({ kind: "external", label: "MCP client" }))]), null);
    assert.equal(chip([desktop({ controller: "user", actor: chat("t1"), since: "x" })]), null);
    // Control lapsed: the chip goes.
    assert.equal(chip([desktop(null)]), null);
  });

  it("names the agent from its latest action when the control carries no actor", () => {
    const latest = { id: "e1", actor: chat("t1") } as DesktopActionEntry;
    assert.equal(chip([desktop(agent())], { latestAction: () => latest })?.desktopId, "d1");
    assert.equal(chip([desktop(agent())]), null);
  });

  it("hides while the desktop's tab is on screen, and once followed or dismissed stays hidden for that stint", () => {
    const d = desktop(agent(chat("t1"), "s1"));
    assert.equal(chip([d], { tabShown: () => true }), null);
    const followed = new Set(followedStints([d], () => true));
    assert.equal(chip([d], { dismissed: followed }), null);
    // A later stint (control lapsed, then the agent came back) shows again.
    assert.equal(chip([desktop(agent(chat("t1"), "s2"))], { dismissed: followed })?.desktopId, "d1");
  });

  it("points at the most recent stint when the agent drives several desktops", () => {
    const shown = chip([desktop(agent(chat("t1"), "2026-11-10T10:00:00.000Z")), desktop(agent(chat("t1"), "2026-11-10T10:05:00.000Z"), { id: "d2" })]);
    assert.equal(shown?.desktopId, "d2");
  });
});
