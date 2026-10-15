/**
 * The turn policy every catalog tool that causes a turn follows (the executor applies it): never
 * into a broader permission mode, plan mode read from the running turn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_MODES } from "@orquester/api/agent-chat";

import { head, snapshot, turn } from "../fixtures.ts";
import { assertTargetModeNotBroader, openedThreadRuntimeMode, runtimeModesUpTo, runningTurnPlans, type TurnPolicyCaller } from "./turn-policy.ts";

const caller = (over: Partial<TurnPolicyCaller> = {}): TurnPolicyCaller => ({ threadId: "me", title: "Main", runtimeMode: "auto", planning: false, ...over });

test("(a) a target broader than the caller is refused; the same or narrower is not", () => {
  for (const [i, callerMode] of RUNTIME_MODES.entries()) {
    for (const [j, targetMode] of RUNTIME_MODES.entries()) {
      const check = () => assertTargetModeNotBroader(caller({ runtimeMode: callerMode }), { threadId: "t", runtimeMode: targetMode });
      if (j > i) assert.throws(check, (e: { code: string }) => e.code === "PERMISSION_DENIED", `${callerMode} → ${targetMode}`);
      else assert.doesNotThrow(check, `${callerMode} → ${targetMode}`);
    }
  }
});

test("(a) a thread the caller opens runs in its mode by default, or a narrower one named; a broader one is refused", () => {
  for (const [i, callerMode] of RUNTIME_MODES.entries()) {
    const c = caller({ runtimeMode: callerMode });
    assert.equal(openedThreadRuntimeMode(c, undefined), callerMode);
    assert.deepEqual(runtimeModesUpTo(callerMode), RUNTIME_MODES.slice(0, i + 1));
    for (const [j, requested] of RUNTIME_MODES.entries()) {
      const pick = () => openedThreadRuntimeMode(c, requested);
      if (j > i) assert.throws(pick, (e: { code: string }) => e.code === "PERMISSION_DENIED", `${callerMode} → ${requested}`);
      else assert.equal(pick(), requested, `${callerMode} → ${requested}`);
    }
  }
});

test("(b) the running turn's plan mode: active turn first, else the latest unsettled, else the latest", () => {
  const planTurn = turn({ turnId: "t2", state: "running", completedAt: null, interactionMode: "plan" });
  assert.equal(runningTurnPlans(snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [turn(), planTurn] })), true);
  assert.equal(runningTurnPlans(snapshot({ head: head({ session: { status: "running", activeTurnId: null } }), turns: [turn(), planTurn] })), true);
  assert.equal(runningTurnPlans(snapshot({ turns: [turn({ interactionMode: "default" })] })), false);
  assert.equal(runningTurnPlans(snapshot({ turns: [] })), false);
});

test("(b) a default turn the user steered into plan mode plans (T6-M2)", () => {
  const running = turn({ turnId: "t2", state: "running", completedAt: null, interactionMode: "default" });
  const steer = { kind: "message", id: "u2", role: "user", text: "plan it first", turnId: "t2", streaming: false, createdAt: "t", updatedAt: "t", interactionMode: "plan" };
  const snap = snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [running] });
  assert.equal(runningTurnPlans(snap), false);
  assert.equal(runningTurnPlans({ ...snap, items: [...snap.items, steer] } as typeof snap), true);
});

test("(a) an unknown mode fails closed: a caller's is the narrowest (reaches nothing, opens nothing broader), a target's the broadest", () => {
  const unknown = "god-mode" as never;
  const odd = caller({ runtimeMode: unknown });
  assert.deepEqual(runtimeModesUpTo(unknown), []);
  for (const mode of RUNTIME_MODES) {
    assert.throws(() => assertTargetModeNotBroader(odd, { threadId: "t", runtimeMode: mode }), (e: { code: string }) => e.code === "PERMISSION_DENIED", mode);
    assert.throws(() => openedThreadRuntimeMode(odd, mode), (e: { code: string }) => e.code === "PERMISSION_DENIED", mode);
  }
  assert.equal(openedThreadRuntimeMode(odd, undefined), "approval-required", "a chat opened by such a caller gets the narrowest mode");
  assert.throws(() => assertTargetModeNotBroader(caller({ runtimeMode: "full-access" }), { threadId: "t", runtimeMode: unknown }), (e: { code: string }) => e.code === "PERMISSION_DENIED");
});
