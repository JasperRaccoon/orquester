/**
 * A Claude workflow group as it renders: the header counts members, never
 * the coordinator, and says nothing of settling before a member exists.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveAgentPanelModel, foldSubagentActivities } from "@orquester/api/agent-chat";

import { activity, CLAUDE_WORKFLOW_ID as WF, claudeWorkflow } from "../../../lib/agent-chat/test-helpers";
import { WorkflowGroup, type WorkflowGroupProps } from "./WorkflowGroup";

function render(
  rows: ReturnType<typeof activity>[],
  stop: Pick<WorkflowGroupProps, "stopControl" | "onStopTask"> = {}
): string {
  const group = deriveAgentPanelModel({ agents: foldSubagentActivities(rows) }).workflows[0];
  assert.ok(group);
  return renderToStaticMarkup(createElement(WorkflowGroup, { group, onOpenAgent: () => {}, ...stop }));
}

describe("WorkflowGroup", () => {
  it("counts the members settled and lists them by phase, the name opening the coordinator", () => {
    const html = render([
      activity("task.started", claudeWorkflow.coordinator()),
      activity("task.progress", claudeWorkflow.member(1, { status: "completed" })),
      activity("task.progress", claudeWorkflow.member(2, { status: "running" })),
      activity("task.progress", claudeWorkflow.member(3, { status: "pending" }))
    ]);
    assert.match(html, /1\/3 settled/);
    assert.match(html, new RegExp(`data-agent-id="${WF}"[^>]*>jasper-understand-research<`));
    for (const n of [1, 2, 3]) assert.match(html, new RegExp(`data-agent-id="${WF}:wf:${n}"`));
    assert.match(html, /Gather/);
    assert.match(html, /Combine/);
  });

  it("renders the coordinator's own row, and no settled counter, before any member", () => {
    const html = render([activity("task.started", claudeWorkflow.coordinator())]);
    assert.doesNotMatch(html, /settled/);
    assert.match(html, /aria-label="Understand the research — Working"/);
  });
});

describe("WorkflowGroup — the run's own Stop", () => {
  const live = () => [
    activity("task.started", claudeWorkflow.coordinator()),
    activity("task.progress", claudeWorkflow.member(1, { status: "running" }))
  ];
  const onStopTask = () => {};

  it("offers none unless asked to", () => {
    assert.doesNotMatch(render(live()), /data-task-stop/);
    assert.doesNotMatch(render(live(), { stopControl: "hidden", onStopTask }), /data-task-stop/);
  });

  it("offers one Stop for the run — none per member — and disables it while stopping", () => {
    const ready = render(live(), { stopControl: "ready", onStopTask });
    assert.equal(ready.match(/data-task-stop="true"/g)?.length, 1);
    assert.match(ready, />Stop</);
    assert.match(ready, /title="Stop jasper-understand-research and all of its agents"/);
    const stopping = render(live(), { stopControl: "stopping", onStopTask });
    assert.match(stopping, /<button[^>]*disabled=""[^>]*data-task-stop="true"[^>]*>Stopping…</);
  });
});
