import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkflowChip } from "./WorkflowChip.tsx";
import { subscribeOpenWorkflowRun } from "../../lib/workflows/open-bridge.ts";

const owner = { kind: "workflow" as const, workflowId: "wf-1", runId: "run-1", nodeId: "node-1" };

test("a workflow's chat tab shows the chip; any other tab shows nothing", () => {
  const html = renderToStaticMarkup(createElement(WorkflowChip, { session: { kind: "agent-chat", owner } }));
  assert.match(html, /<button/);
  assert.match(html, />Workflow</);
  assert.equal(renderToStaticMarkup(createElement(WorkflowChip, { session: { kind: "agent-chat" } })), "");
  assert.equal(renderToStaticMarkup(createElement(WorkflowChip, { session: { kind: "shell", owner } })), "");
  assert.equal(renderToStaticMarkup(createElement(WorkflowChip, { session: null })), "");
});

test("the compact chip is the icon alone, still labelled for a screen reader", () => {
  const html = renderToStaticMarkup(
    createElement(WorkflowChip, { session: { kind: "agent-chat", owner }, compact: true })
  );
  assert.doesNotMatch(html, />Workflow</);
  assert.match(html, /aria-label="Open the workflow run that started this chat"/);
});

test("clicking the chip opens its run and stops only its own click", () => {
  const opened: unknown[] = [];
  const stop = subscribeOpenWorkflowRun((target) => opened.push(target));
  let openedCallbacks = 0;
  const element = WorkflowChip({ session: { kind: "agent-chat", owner }, onOpened: () => (openedCallbacks += 1) });
  assert.ok(element && typeof element === "object" && "props" in element);
  const props = (element as { props: Record<string, unknown> }).props;
  assert.equal(props.onDoubleClick, undefined, "a double-click still reaches the tab (rename)");
  assert.equal(props.onMouseDown, undefined, "a drag still starts on the tab");
  let stopped = 0;
  (props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1);
  assert.deepEqual(opened, [{ workflowId: "wf-1", runId: "run-1", nodeId: "node-1" }]);
  assert.equal(openedCallbacks, 1);
  stop();
  // With nothing listening the click is a no-op: no error, and nothing to close.
  (props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => undefined });
  assert.equal(openedCallbacks, 1);
});
