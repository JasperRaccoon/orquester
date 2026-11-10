import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesktopActor, DesktopControl } from "@orquester/api";
import { agentInputControl, requestedControl } from "./control.ts";

// The handoff rules (spec 2026-11-10 §3.1 R2.2). The lapse timer lives in the automation service
// (automation-service.test.ts).

const CLAUDE: DesktopActor = { kind: "chat", threadId: "t1", label: "Claude" };
const CODEX: DesktopActor = { kind: "chat", threadId: "t2", label: "Codex" };
const T0 = "2026-11-10T10:00:00.000Z";
const T1 = "2026-11-10T10:01:00.000Z";

test("agent input claims control unless the user has it; the holder keeps its since, another agent takes over", () => {
  const claimed = agentInputControl(null, CLAUDE, T0);
  assert.deepEqual(claimed, { ok: true, control: { controller: "agent", actor: CLAUDE, since: T0 } });
  const held = (claimed as { control: DesktopControl }).control;
  assert.deepEqual(agentInputControl(held, { ...CLAUDE, label: "Claude Opus" }, T1), { ok: true, control: held });
  assert.deepEqual(agentInputControl(held, CODEX, T1), { ok: true, control: { controller: "agent", actor: CODEX, since: T1 } });
  assert.deepEqual(agentInputControl({ controller: "user", actor: CLAUDE, since: T0 }, CLAUDE, T1), { ok: false });
});

test("take over remembers the agent; give back returns to it (clears without one); null clears", () => {
  const agent: DesktopControl = { controller: "agent", actor: CLAUDE, since: T0 };
  const user = requestedControl(agent, "user", T1);
  assert.deepEqual(user, { controller: "user", actor: CLAUDE, since: T1 });
  assert.equal(requestedControl(user, "user", T0), user, "taking over twice changes nothing");
  assert.deepEqual(requestedControl(user, "agent", T0), { controller: "agent", actor: CLAUDE, since: T0 });
  assert.equal(requestedControl({ controller: "user", since: T0 }, "agent", T1), null, "no agent to give it back to");
  assert.equal(requestedControl(agent, "agent", T1), agent);
  assert.equal(requestedControl(user, null, T1), null);
  assert.deepEqual(requestedControl(null, "user", T1), { controller: "user", since: T1 });
});
