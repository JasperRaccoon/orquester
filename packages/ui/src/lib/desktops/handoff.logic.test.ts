import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopActionEntry, DesktopControl } from "@orquester/api";

import {
  appendDesktopAction,
  desktopActionLogRows,
  desktopControlPill,
  desktopHasHandoff,
  EMPTY_DESKTOP_RING,
  inputTakesOver,
  mergeDesktopActionLog,
  parseDesktopActionEvent,
  parseDesktopControl,
  sizeLockNotice,
  unseenBadge
} from "./handoff.logic.ts";

const claude = { kind: "chat", threadId: "t1", label: "Claude" } as const;
const agent = (since = "2026-11-10T10:00:00.000Z"): DesktopControl => ({ controller: "agent", actor: claude, since });
const entry = (id: string, second = 0, overrides: Partial<DesktopActionEntry> = {}): DesktopActionEntry => ({
  id,
  at: new Date(Date.UTC(2026, 10, 10, 10, 0, second)).toISOString(),
  actor: claude,
  kind: "click",
  summary: `Clicked ${id}`,
  ok: true,
  ...overrides
});

describe("control pill", () => {
  it("is hidden while nobody controls the desktop, whatever an older daemon sends", () => {
    for (const control of [undefined, null, {}, { controller: "robot", since: "x" }, { controller: "agent" }]) {
      assert.equal(desktopControlPill(parseDesktopControl(control)), null);
    }
  });

  it("offers Take over while an agent controls it, and Give back once the user does", () => {
    const taking = desktopControlPill(agent());
    assert.equal(taking?.tone, "agent");
    assert.match(taking!.text, /Claude/);
    assert.equal(taking!.action.controller, "user");
    const giving = desktopControlPill({ controller: "user", actor: claude, since: "2026-11-10T10:01:00.000Z" });
    assert.equal(giving?.tone, "user");
    assert.equal(giving!.action.controller, "agent");
    assert.match(giving!.action.ariaLabel, /Claude/);
  });

  it("locks the size only while an agent controls the desktop", () => {
    assert.match(sizeLockNotice(agent()) ?? "", /Claude/);
    assert.equal(sizeLockNotice({ controller: "user", since: "x" }), null);
    assert.equal(sizeLockNotice(null), null);
  });
});

describe("implicit takeover", () => {
  it("takes control once per agent stint, never from nobody or from the user", () => {
    assert.equal(inputTakesOver(null, null), false);
    assert.equal(inputTakesOver({ controller: "user", since: "a" }, null), false);
    assert.equal(inputTakesOver(agent("a"), null), true);
    // The PUT is in flight (or its event not back yet): the next input does not ask again.
    assert.equal(inputTakesOver(agent("a"), "a"), false);
    // The agent took the desktop back later: a new stint, so input takes over again.
    assert.equal(inputTakesOver(agent("b"), "a"), true);
  });
});

describe("the recent-actions ring and its Activity badge", () => {
  it("counts live actions until the log is looked at; history and repeats never count", () => {
    let ring = mergeDesktopActionLog(EMPTY_DESKTOP_RING, [entry("old1", 1), entry("old2", 2)]);
    assert.equal(ring.unseen, 0);
    assert.equal(unseenBadge(ring.unseen), null);
    ring = appendDesktopAction(ring, entry("a", 3), false);
    ring = appendDesktopAction(ring, entry("a", 3), false);
    ring = appendDesktopAction(ring, entry("b", 4), false);
    assert.equal(unseenBadge(ring.unseen), "2");
    // While the popover is open, what arrives is seen.
    assert.equal(appendDesktopAction(ring, entry("c", 5), true).unseen, 0);
    // A reload of the log after live events neither duplicates nor counts them.
    const reloaded = mergeDesktopActionLog(ring, [entry("old2", 2), entry("a", 3), entry("b", 4)]);
    assert.deepEqual(reloaded.entries.map((e) => e.id), ["old1", "old2", "a", "b"]);
    assert.equal(reloaded.unseen, 2);
  });

  it("keeps the last 50 actions and caps the badge", () => {
    let ring = EMPTY_DESKTOP_RING;
    for (let i = 0; i < 60; i += 1) ring = appendDesktopAction(ring, entry(`e${i}`, i), false);
    assert.equal(ring.entries.length, 50);
    assert.equal(ring.entries[0]!.id, "e10");
    assert.equal(unseenBadge(ring.unseen), "9+");
  });

  it("lists the log newest first", () => {
    const ring = mergeDesktopActionLog(EMPTY_DESKTOP_RING, [entry("b", 2), entry("a", 1, { kind: "screenshot", screenshotId: "s1", summary: "Took a screenshot" })]);
    const rows = desktopActionLogRows(ring.entries);
    assert.deepEqual(rows.map((row) => row.id), ["b", "a"]);
    assert.equal(rows[1]!.screenshotId, "s1");
  });

  it("shows no handoff UI for a desktop nobody automated", () => {
    assert.equal(desktopHasHandoff(null, EMPTY_DESKTOP_RING), false);
    assert.equal(desktopHasHandoff(agent(), EMPTY_DESKTOP_RING), true);
    assert.equal(desktopHasHandoff(null, appendDesktopAction(EMPTY_DESKTOP_RING, entry("a"), false)), true);
  });

  it("drops an event that is not one before it reaches the ring", () => {
    assert.equal(parseDesktopActionEvent({ desktopId: "d1", entry: { ...entry("a"), kind: "teleport" } }), null);
    assert.equal(parseDesktopActionEvent({ desktopId: "d1", entry: { ...entry("a"), actor: { kind: "chat", label: "Claude" } } }), null);
    assert.equal(parseDesktopActionEvent({ entry: entry("a") }), null);
    assert.equal(parseDesktopActionEvent({ desktopId: "d1", entry: { ...entry("a"), text: "x".repeat(500) } })?.entry.text?.length, 60);
  });
});
