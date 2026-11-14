/**
 * A live subagent, a nested one and a background shell each carry their own
 * Stop where the provider can stop one task: it stops that task alone and
 * never opens it, while the row around it still opens the agent.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { deriveAgentPanelModel, type RuntimeSubagent } from "@orquester/api/agent-chat";
import { AgentRoster } from "./AgentRoster";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(() => {
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
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let root: Root;

beforeEach(() => {
  const mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const task = (id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent => ({
  id,
  kind: "subagent",
  agentKind: "agent",
  title: id,
  role: null,
  model: null,
  effort: null,
  status: "running",
  activationCount: 1,
  usage: null,
  progress: null,
  lastToolName: null,
  result: null,
  error: null,
  outputFile: null,
  exitCode: null,
  isBackgrounded: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

const agents = [
  task("reviewer"),
  task("nested", { parentAgentId: "reviewer" }),
  task("tests", { agentKind: "background" })
];

const button = (name: string): HTMLButtonElement => {
  const found = [...dom.window.document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name
  );
  assert.ok(found, `a button labelled "${name}"`);
  return found;
};

async function renderRoster(input: { stoppingTaskIds?: readonly string[] } = {}) {
  const opened: string[] = [];
  const stopped: string[] = [];
  await act(async () => {
    root.render(
      createElement(AgentRoster, {
        sessionId: "s1",
        agents,
        panel: deriveAgentPanelModel({ agents }),
        expanded: false,
        onExpandedChange: () => {},
        onOpenAgent: (id: string) => opened.push(id),
        canStopTasks: true,
        stoppingTaskIds: input.stoppingTaskIds ?? [],
        onStopTask: (id: string) => stopped.push(id)
      })
    );
  });
  return { opened, stopped };
}

describe("a roster row's own Stop", () => {
  it("stops that task alone without opening it, and the row still opens", async () => {
    const { opened, stopped } = await renderRoster();
    await act(async () => {
      button("Stop nested").click();
      button("Stop tests").click();
    });
    assert.deepEqual(stopped, ["nested", "tests"]);
    assert.deepEqual(opened, []);

    await act(async () => {
      button("reviewer — Working").click();
    });
    assert.deepEqual(opened, ["reviewer"]);
    assert.deepEqual(stopped, ["nested", "tests"]);
  });

  it("cannot be clicked again while the stop is in flight", async () => {
    const { stopped } = await renderRoster({ stoppingTaskIds: ["reviewer"] });
    const stopping = button("Stopping reviewer");
    assert.equal(stopping.disabled, true);
    await act(async () => {
      stopping.click();
    });
    assert.deepEqual(stopped, []);
  });
});
