/**
 * A block's run details, mounted: an earlier pass of a looped block shows no
 * log — the daemon keeps only the latest pass's (attempts restart with each
 * pass, so an attempt number cannot name an earlier pass's log) — while the
 * latest pass streams its own.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { WorkflowBlockRun, WorkflowRun } from "@orquester/api";

import type { WorkflowRunEntry } from "../../../lib/workflows/store";
import { node, workflow } from "../../../lib/workflows/testing";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let BlockRunDetails: typeof import("./BlockRunDetails").BlockRunDetails;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ BlockRunDetails } = await import("./BlockRunDetails"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const T0 = "2026-11-10T10:00:00.000Z";
const definition = workflow([node("t", "trigger.manual"), node("sh", "shell", {}, { name: "Build" })]);

/** Pass 2 retried once (attempt 2); pass 1 ran once (attempt 1 of its own) — its attempt is lower, yet not its log. */
const looped: WorkflowBlockRun = {
  nodeId: "sh",
  name: "Build",
  type: "shell",
  status: "succeeded",
  attempt: 2,
  pass: 2,
  startedAt: T0,
  endedAt: T0,
  logs: { stdoutBytes: 10, stderrBytes: 0 },
  passes: [{ pass: 1, status: "succeeded", attempt: 1, startedAt: T0, endedAt: T0, logs: { stdoutBytes: 10, stderrBytes: 0 } }]
};

function entry(): WorkflowRunEntry {
  const summary = { id: "r1", workflowId: "wf-1", workflowName: "Test", status: "succeeded" as const, trigger: { kind: "manual" as const }, test: false, queuedAt: T0, startedAt: T0, endedAt: T0 };
  return {
    summary,
    detail: { ...summary, definition, triggerPayload: null, blocks: { sh: looped }, takenEdges: [], deadEdges: [] } as unknown as WorkflowRun,
    blocks: { sh: looped },
    takenEdges: [],
    deadEdges: [],
    error: null
  };
}

let mount: HTMLDivElement;
let root: Root;
let logReads: number[];

const api = {
  readWorkflowNodeLogWindow: (_runId: string, _nodeId: string, request: { offset?: number }) => {
    logReads.push(request.offset ?? 0);
    return new Promise(() => undefined);
  },
  openWorkflowNodeLog: () => new Promise(() => undefined),
  getWorkflowNodeOutput: () => new Promise(() => undefined)
} as never;

function render(initialPass?: number): void {
  act(() => {
    root.render(
      createElement(BlockRunDetails, {
        api,
        entry: entry(),
        nodeId: "sh",
        now: Date.parse(T0),
        initialTab: "logs",
        ...(initialPass !== undefined ? { initialPass } : {})
      })
    );
  });
}

beforeEach(() => {
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  logReads = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("a looped block's logs", () => {
  it("an earlier pass says only the latest pass's log is kept, and reads no log", () => {
    render(1);
    assert.match(mount.textContent ?? "", /Pass 1 of 2/);
    assert.match(mount.textContent ?? "", /Only the latest pass's log is kept\./);
    assert.deepEqual(logReads, [], "the latest pass's log is never shown as pass 1's");
  });

  it("the latest pass shows its log", () => {
    render();
    assert.doesNotMatch(mount.textContent ?? "", /Only the latest pass's log/);
    assert.ok(mount.querySelector('[role="tabpanel"]')?.childElementCount, "the log viewer is there");
  });
});
