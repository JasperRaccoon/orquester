/**
 * The turn policy every session tool that causes a turn follows: never into a broader permission
 * mode, plan mode carried on, provenance the receiving model reads.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadMessage, RUNTIME_MODES } from "@orquester/api/agent-chat";

import { chatSummary, head, snapshot, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import type { SessionToolContext } from "../../session-tools/contract.ts";
import {
  assertTargetModeNotBroader,
  interactionModeFor,
  openedThreadRuntimeMode,
  readTurnPolicyCaller,
  runtimeModesUpTo,
  runningTurnPlans,
  TURN_PROVENANCE_OVERHEAD_CHARS,
  turnPolicyCallerFrom,
  withProvenance,
  type TurnPolicyCaller
} from "./turn-policy.ts";

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

test("(b) a planning caller's turn plans, and an agent with no plan mode is refused; plan support is asked only then", async () => {
  let asked = 0;
  const supports = (value: boolean) => () => { asked += 1; return value; };
  assert.equal(await interactionModeFor(caller(), { agent: "codex", supportsPlanMode: supports(false) }), "default");
  assert.equal(asked, 0);
  assert.equal(await interactionModeFor(caller({ planning: true }), { agent: "claude", supportsPlanMode: supports(true) }), "plan");
  await assert.rejects(interactionModeFor(caller({ planning: true }), { agent: "codex", supportsPlanMode: async () => false }), (e: { code: string; message: string }) => e.code === "PERMISSION_DENIED" && /codex has no plan mode/.test(e.message));
});

test("(c) provenance: the receiving model reads which thread sent it and that it is not the user; the GUI reads it back", () => {
  const text = withProvenance(caller({ title: 'Say "hi"\nthere' }), "sent", "/goal ship it");
  assert.ok(text.startsWith('[Sent by thread "Say \\"hi\\" there"]\n'));
  assert.match(text, /not from the user/);
  assert.ok(!text.startsWith("/"), "a slash command is plain text now");
  assert.deepEqual(parseThreadMessage(text), { origin: "sent", fromTitle: 'Say "hi" there', body: "/goal ship it" });
  for (const origin of ["opened", "delegated"] as const) assert.equal(parseThreadMessage(withProvenance(caller(), origin, "x"))?.origin, origin);
  assert.ok(withProvenance(caller({ title: "t".repeat(1_000) }), "delegated", "").length <= TURN_PROVENANCE_OVERHEAD_CHARS);
  assert.equal(parseThreadMessage("[Sent by thread x] hi"), null);
});

test("the caller is read through the daemon API", async () => {
  const api = new FakeDaemonApi();
  api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "me", title: "Main" })] });
  api.on("GET", "/api/sessions/me/thread", { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ runtimeMode: "approval-required", session: { status: "running", activeTurnId: "t1" } }), turns: [turn({ state: "running", interactionMode: "plan" })] }) } });
  const ctx = { threadId: "me", api } as unknown as SessionToolContext;
  assert.deepEqual(await readTurnPolicyCaller(ctx), { threadId: "me", title: "Main", runtimeMode: "approval-required", planning: true });
  assert.deepEqual(turnPolicyCallerFrom({ id: "x", title: "X" }, snapshot()), { threadId: "x", title: "X", runtimeMode: "full-access", planning: false });
});
