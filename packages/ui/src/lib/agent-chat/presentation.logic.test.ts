import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { ToolApprovalReference } from "@orquester/api/agent-chat";

import type { WorkLogEntry } from "./contracts";
import {
workEntryDisplayIndicatesToolFailure,
workEntryDisplayLabel
} from "./presentation.logic";

const entry = (overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id: overrides.id ?? "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  turnId: overrides.turnId ?? "t1",
  label: overrides.label ?? "Tool",
  tone: overrides.tone ?? "tool",
  ...overrides
});

describe("the output heuristic never judges a call still in progress", () => {
  // A running command's row carries its output so far once its chunks are joined into it: a line that merely prints
  // "No such file or directory" is not the call failing. It is judged when it completes.
  const running = entry({
    command: "npm run build",
    itemType: "command_execution",
    sourceActivityKind: "tool.started",
    toolLifecycleStatus: "inProgress",
    detail: "compiling\ncat: x: No such file or directory\nstill going\n"
  });

  it("an in-progress call is not failed by its output, however it reads", () => {
    assert.equal(workEntryDisplayIndicatesToolFailure(running), false);
  });
});

describe("session tool labels (unified MCP §4)", () => {

  it("a gated call's row says how its card ended", () => {
    const gated = (
      outcome: ToolApprovalReference["outcome"],
      kind: "admin" | "toolset" = "admin",
      extra: Pick<ToolApprovalReference, "reason" | "grantScope"> = {}
    ) =>
      workEntryDisplayLabel(
        entry({
          sessionTool: kind === "toolset" ? "request_toolset" : "create_workflow",
          toolApproval: { kind, family: kind === "toolset" ? "toolset" : "workflows", title: "t", outcome, ...(outcome === "granted" ? {} : { approvalId: "a" }), ...extra }
        })
      );
    assert.equal(gated("approved"), "Created a workflow · Approved by you");
    assert.equal(gated("granted"), "Created a workflow · Allowed by a grant");
    assert.equal(gated("denied"), "Created a workflow · Denied by you");
    assert.equal(gated("timed_out"), "Created a workflow · Expired");
    assert.equal(gated("cancelled"), "Created a workflow · Cancelled");
    assert.equal(gated("approved", "toolset"), "Asked for more tools · Enabled by you");
    assert.match(gated("not_delivered"), /never reached the agent/);
    // The reference's deny reason and grant scope (contracts follow-up).
    assert.equal(gated("denied", "admin", { reason: "not on\n  Fridays" }), "Created a workflow · Denied: not on Fridays");
    assert.equal(gated("denied", "admin", { reason: "  " }), "Created a workflow · Denied by you");
    assert.equal(gated("granted", "admin", { grantScope: "chat" }), "Created a workflow · Allowed by a chat grant");
    assert.equal(gated("granted", "admin", { grantScope: "project" }), "Created a workflow · Allowed by a project grant");
    // No card: the tool's own label.
    assert.equal(workEntryDisplayLabel(entry({ sessionTool: "list_projects" })), "Listed projects");
  });
});

describe("device tool rows (devices §10.3)", () => {
  const device = { device: "local/emulator-5554", leaseId: "l1" };

  it("preserves device names and action targets, resolving a missing name from the store", () => {
    const named = entry({ sessionTool: "open_device", deviceLink: { ...device, name: "Pixel 9" } });
    const label = workEntryDisplayLabel(named, undefined, () => "Pixel Fold");
    assert.match(label, /Pixel 9/);
    assert.doesNotMatch(label, /Pixel Fold/);
    assert.match(workEntryDisplayLabel(entry({ sessionTool: "open_device", deviceLink: device }), undefined, () => "Pixel Fold"), /Pixel Fold/);
    assert.match(workEntryDisplayLabel(entry({ sessionTool: "device_action", deviceLink: { ...device, action: "tap", summary: "Tapped @e7 “Search”" } })), /Search/);
  });

  it("keeps the approval outcome alongside the device name", () => {
    const label = workEntryDisplayLabel(entry({
      sessionTool: "open_device",
      deviceLink: { ...device, name: "iPhone 17 Pro" },
      toolApproval: { kind: "spend", family: "devices", title: "t", outcome: "approved", approvalId: "a" }
    }));
    assert.match(label, /iPhone 17 Pro/);
    assert.match(label, /Approved/);
  });
});
