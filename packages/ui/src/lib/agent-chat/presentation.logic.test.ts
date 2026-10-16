import assert from "node:assert/strict";
import { describe,it } from "node:test";

import { chatToolNames, TOOLSETS } from "@orquester/api";

import type { WorkLogEntry } from "./contracts";
import {
SESSION_TOOL_LABELS,
toolApprovalOutcomeText,
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
  it("every chat tool of the catalogue has its own label, read from TOOLSETS", () => {
    const names = TOOLSETS.flatMap((toolset) => toolset.tools.map((tool) => tool.name));
    assert.equal(names.length, 45);
    assert.deepEqual(names, chatToolNames());
    for (const name of names) {
      assert.ok(Object.hasOwn(SESSION_TOOL_LABELS, name), `${name} has no label`);
      assert.doesNotMatch(SESSION_TOOL_LABELS[name]!, /^Orquester:/);
    }
  });

  it("every legacy name keeps a label: the old in-chat tools and the external names the catalogue replaced", () => {
    const legacy = [
      "thread_list", "thread_read", "thread_create", "agent_catalog", "thread_send", "thread_wait", "thread_interrupt",
      "thread_fork", "thread_merge_back", "delegate_task", "task_status", "task_wait", "task_cancel",
      "get_session_lineage", "interrupt_session", "stop_task", "stop_session", "close_session", "revert_session",
      "compact_session", "implement_plan", "resolve_merge_back", "answer_question", "dismiss_question", "resolve_approval",
      "get_cost", "list_files", "create_todo", "update_todo", "delete_todo", "toggle_todo_item", "validate_workflow",
      "list_workflow_runs", "get_workflow_run", "list_agent_profiles", "get_agent_profile_item", "get_agent_instructions",
      "list_marketplace_plugins", "desktops_list", "desktop_host_status", "desktop_windows", "desktop_app_log",
      "desktop_open", "desktop_launch_app", "desktop_window_action", "desktop_stop_app", "desktop_close",
      // The eight agent-profile write tools `edit_agent_profile` replaced.
      "create_agent_profile_item", "update_agent_profile_item", "delete_agent_profile_item", "copy_agent_profile_item",
      "set_agent_profile_item_enabled", "trust_agent_profile_hook", "write_agent_instructions", "import_agent_profile_items"
    ];
    for (const name of legacy) {
      assert.ok(Object.hasOwn(SESSION_TOOL_LABELS, name), `${name} has no label`);
      assert.doesNotMatch(SESSION_TOOL_LABELS[name]!, /^Orquester:/);
    }
    // Old transcripts read as before.
    assert.equal(SESSION_TOOL_LABELS.thread_wait, "Waited for a chat");
    assert.equal(SESSION_TOOL_LABELS.delegate_task, "Delegated a task");
  });

  it("a gated call's row says how its card ended", () => {
    const gated = (outcome: "approved" | "granted" | "denied" | "timed_out" | "cancelled" | "not_delivered", kind: "admin" | "toolset" = "admin") =>
      workEntryDisplayLabel(
        entry({
          sessionTool: kind === "toolset" ? "request_toolset" : "create_workflow",
          toolApproval: { kind, family: kind === "toolset" ? "toolset" : "workflows", title: "t", outcome, ...(outcome === "granted" ? {} : { approvalId: "a" }) }
        })
      );
    assert.equal(gated("approved"), "Created a workflow · Approved by you");
    assert.equal(gated("granted"), "Created a workflow · Allowed by a grant");
    assert.equal(gated("denied"), "Created a workflow · Denied by you");
    assert.equal(gated("timed_out"), "Created a workflow · Expired");
    assert.equal(gated("cancelled"), "Created a workflow · Cancelled");
    assert.equal(gated("approved", "toolset"), "Asked for more tools · Enabled by you");
    assert.match(toolApprovalOutcomeText({ kind: "admin", outcome: "not_delivered" }), /never reached the agent/);
    // The reference's deny reason and grant scope (contracts follow-up).
    assert.equal(toolApprovalOutcomeText({ kind: "admin", outcome: "denied", reason: "not on\n  Fridays" }), "Denied: not on Fridays");
    assert.equal(toolApprovalOutcomeText({ kind: "admin", outcome: "denied", reason: "  " }), "Denied by you");
    assert.equal(toolApprovalOutcomeText({ kind: "admin", outcome: "granted", grantScope: "chat" }), "Allowed by a chat grant");
    assert.equal(toolApprovalOutcomeText({ kind: "admin", outcome: "granted", grantScope: "project" }), "Allowed by a project grant");
    // No card: the tool's own label.
    assert.equal(workEntryDisplayLabel(entry({ sessionTool: "list_projects" })), "Listed projects");
  });
});
