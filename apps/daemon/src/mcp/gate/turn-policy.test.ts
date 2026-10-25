/**
 * The turn policy every catalog tool that causes a turn follows (the executor applies it): never
 * into a broader permission mode, plan mode read from the running turn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { assertTargetModeNotBroader, openedThreadRuntimeMode, runtimeModesUpTo, type TurnPolicyCaller } from "./turn-policy.ts";

const MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

const caller = (over: Partial<TurnPolicyCaller> = {}): TurnPolicyCaller => ({ threadId: "me", title: "Main", runtimeMode: "auto", planning: false, ...over });

test("(a) a target broader than the caller is refused; the same or narrower is not", () => {
  for (const [i, callerMode] of MODES.entries()) {
    for (const [j, targetMode] of MODES.entries()) {
      const check = () => assertTargetModeNotBroader(caller({ runtimeMode: callerMode }), { threadId: "t", runtimeMode: targetMode });
      if (j > i) assert.throws(check, (e: { code: string }) => e.code === "PERMISSION_DENIED", `${callerMode} → ${targetMode}`);
      else assert.doesNotThrow(check, `${callerMode} → ${targetMode}`);
    }
  }
});

test("(a) a thread the caller opens runs in its mode by default, or a narrower one named; a broader one is refused", () => {
  for (const [i, callerMode] of MODES.entries()) {
    const c = caller({ runtimeMode: callerMode });
    assert.equal(openedThreadRuntimeMode(c, undefined), callerMode);
    assert.deepEqual(runtimeModesUpTo(callerMode), MODES.slice(0, i + 1));
    for (const [j, requested] of MODES.entries()) {
      const pick = () => openedThreadRuntimeMode(c, requested);
      if (j > i) assert.throws(pick, (e: { code: string }) => e.code === "PERMISSION_DENIED", `${callerMode} → ${requested}`);
      else assert.equal(pick(), requested, `${callerMode} → ${requested}`);
    }
  }
});

test("(a) an unknown mode fails closed: a caller's is the narrowest (reaches nothing, opens nothing broader), a target's the broadest", () => {
  const unknown = "god-mode" as never;
  const odd = caller({ runtimeMode: unknown });
  assert.deepEqual(runtimeModesUpTo(unknown), []);
  for (const mode of MODES) {
    assert.throws(() => assertTargetModeNotBroader(odd, { threadId: "t", runtimeMode: mode }), (e: { code: string }) => e.code === "PERMISSION_DENIED", mode);
    assert.throws(() => openedThreadRuntimeMode(odd, mode), (e: { code: string }) => e.code === "PERMISSION_DENIED", mode);
  }
  assert.equal(openedThreadRuntimeMode(odd, undefined), "approval-required", "a chat opened by such a caller gets the narrowest mode");
  assert.throws(() => assertTargetModeNotBroader(caller({ runtimeMode: "full-access" }), { threadId: "t", runtimeMode: unknown }), (e: { code: string }) => e.code === "PERMISSION_DENIED");
});
