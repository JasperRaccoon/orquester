import assert from "node:assert/strict";
import test from "node:test";

import { currentInteractionMode } from "./interaction-mode.ts";
import type { ThreadItem, Turn } from "./thread.ts";

const turn = (turnId: string, state: Turn["state"], interactionMode?: "default" | "plan"): Turn =>
  ({ turnId, state, turnCount: null, requestedAt: "t", startedAt: "t", completedAt: null, assistantMessageId: null, ...(interactionMode ? { interactionMode } : {}) }) as Turn;
const user = (id: string, turnId: string, interactionMode?: "default" | "plan"): ThreadItem =>
  ({ kind: "message", id, role: "user", text: "x", turnId, streaming: false, createdAt: "t", updatedAt: "t", ...(interactionMode ? { interactionMode } : {}) }) as ThreadItem;

test("the running turn's mode, else the latest unsettled, else the latest; default when none", () => {
  assert.equal(currentInteractionMode({ head: { session: { activeTurnId: null } }, turns: [], items: [] }), "default");
  assert.equal(
    currentInteractionMode({ head: { session: { activeTurnId: "t2" } }, turns: [turn("t1", "completed", "default"), turn("t2", "running", "plan")], items: [] }),
    "plan"
  );
  assert.equal(
    currentInteractionMode({ head: { session: { activeTurnId: null } }, turns: [turn("t1", "completed", "plan")], items: [] }),
    "plan",
    "an idle thread keeps its latest turn's mode"
  );
});

test("a steer that switched the running turn's mode is the latest word (T6-M2)", () => {
  const snap = {
    head: { session: { activeTurnId: "t1" } },
    turns: [turn("t1", "running", "default")],
    items: [user("u1", "t1"), user("u2", "t1", "plan")]
  };
  assert.equal(currentInteractionMode(snap), "plan");
  // And back again.
  assert.equal(currentInteractionMode({ ...snap, items: [...snap.items, user("u3", "t1", "default")] }), "default");
  // A message of another turn says nothing about this one.
  assert.equal(currentInteractionMode({ ...snap, items: [user("u9", "t0", "plan")] }), "default");
});

test("a turn that recorded no mode reads as the latest earlier turn that did", () => {
  const none = { turnId: "t2", state: "completed", turnCount: null, requestedAt: "t", startedAt: "t", completedAt: "t", assistantMessageId: null } as Turn;
  assert.equal(currentInteractionMode({ head: { session: { activeTurnId: null } }, turns: [turn("t1", "completed", "plan"), none], items: [] }), "plan");
  assert.equal(currentInteractionMode({ head: { session: { activeTurnId: null } }, turns: [none], items: [] }), "default");
});
