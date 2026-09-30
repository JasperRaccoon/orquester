import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AdapterCapabilities, ProviderSession } from "@orquester/api/agent-chat";

import {
  decideSessionRestart,
  type BoundSessionShape,
  type DesiredSessionShape
} from "./session-policy.ts";

const session: ProviderSession = {
  threadId: "t1",
  status: "ready",
  runtimeMode: "approval-required",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z"
};

const capabilities: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "native" }
};

const shape = (overrides: Partial<DesiredSessionShape> = {}): DesiredSessionShape => ({
  adapter: "codex",
  runtimeMode: "approval-required",
  cwd: "/work/p",
  accountKey: "account:acc1",
  modelSelection: { model: "m1" },
  ...overrides
});

const bound = (overrides: Partial<BoundSessionShape> = {}): BoundSessionShape => ({
  ...shape(),
  session,
  ...overrides
});

describe("session restart policy (§3.4)", () => {
  it("is a no-op when nothing changed", () => {
    const decision = decideSessionRestart({ desired: shape(), bound: bound(), capabilities });
    assert.equal(decision.restart, false);
  });

  it("a cwd change restarts with the resume cursor", () => {
    const decision = decideSessionRestart({
      desired: shape({ cwd: "/work/other" }),
      bound: bound(),
      capabilities
    });
    assert.equal(decision.restart, true);
    assert.equal(decision.carryResumeCursor, true);
  });

  it("applies a model change live where the adapter can switch in session", () => {
    const decision = decideSessionRestart({
      desired: shape({ modelSelection: { model: "m2" } }),
      bound: bound(),
      capabilities
    });
    assert.equal(decision.restart, false);
  });

  it("restarts and DROPS the cursor when the adapter cannot switch model in session", () => {
    const decision = decideSessionRestart({
      desired: shape({ modelSelection: { model: "m2" } }),
      bound: bound(),
      capabilities: { ...capabilities, sessionModelSwitch: "unsupported" }
    });
    assert.equal(decision.restart, true);
    assert.equal(decision.carryResumeCursor, false);
  });

  it("Claude compares the whole selection object, options included", () => {
    const desired = shape({
      adapter: "claude",
      modelSelection: { model: "m1", options: [{ id: "thinking", value: true }] }
    });
    const decision = decideSessionRestart({
      desired,
      bound: bound({ adapter: "claude" }),
      capabilities
    });
    assert.equal(decision.restart, true);
    assert.equal(decision.carryResumeCursor, true);
  });

  it("other adapters ignore an options-only change", () => {
    const desired = shape({
      modelSelection: { model: "m1", options: [{ id: "effort", value: "high" }] }
    });
    const decision = decideSessionRestart({ desired, bound: bound(), capabilities });
    assert.equal(decision.restart, false);
  });
});
