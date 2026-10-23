/**
 * Settings → Host status, the agent host section, in a DOM: a pending restart
 * says what it waits on per chat, a background shell has its own Stop, and
 * "Restart agent host now" asks first, listing what it stops.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentHostStatusResponse } from "@orquester/api/agent-chat";

import { OrquesterProvider } from "../../context/orquester-context";
import { AgentHostRestart } from "./AgentHostRestart";

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

const pending: AgentHostStatusResponse = {
  state: "healthy",
  reason: null,
  hostInstanceId: "host-1",
  pid: 4242,
  codeStamp: "1570de7c8ee6aaaa",
  checkoutCodeStamp: "f5aff27f7805bbbb",
  pendingRestart: {
    reason: "agent host code 1570de7c8ee6 != f5aff27f7805",
    since: "2026-10-23T09:00:00.000Z",
    deferredBy: "1 thread(s) with live background work",
    blockers: [
      {
        threadId: "t1",
        threadTitle: "Auth fixes",
        kind: "background",
        taskId: "b1",
        title: "Run the suite",
        command: "pnpm test > /tmp/x.log",
        since: "2026-10-23T09:03:00.000Z",
        stoppable: true
      }
    ]
  }
};

describe("AgentHostRestart", () => {
  let root: Root;
  let calls: string[];

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const show = async (status: AgentHostStatusResponse) => {
    const api = {
      agentHostStatus: async () => status,
      stopAgentTask: async (sessionId: string, taskId: string) => {
        calls.push(`stop-task ${sessionId} ${taskId}`);
        return { seq: 1 };
      },
      stopAgentSession: async (sessionId: string) => {
        calls.push(`stop-session ${sessionId}`);
        return { seq: 1 };
      },
      restartAgentHost: async () => {
        calls.push("restart");
        return { ok: true, markedThreadIds: [] };
      }
    };
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, { runtime: "web", api: api as never, useTitlebar: false, children: createElement(AgentHostRestart, { live: true }) })
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  const text = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  it("shows what the pending restart waits on, and stops one shell alone", async () => {
    await show(pending);
    assert.ok(text().includes("A restart is pending"), text());
    assert.ok(text().includes("Auth fixes"));
    assert.ok(text().includes("Background shell"));
    assert.ok(text().includes("pnpm test > /tmp/x.log"));
    const stop = button("Stop it");
    assert.ok(stop, "a Stop for the shell");
    await click(stop);
    assert.deepEqual(calls, ["stop-task t1 b1"]);
  });

  it("restarts now only after a confirmation that lists what it stops", async () => {
    await show(pending);
    await click(button("Restart agent host now")!);
    assert.deepEqual(calls, [], "nothing is sent before the confirmation");
    assert.ok(text().includes("Auth fixes: Background shell — Run the suite"), text());
    await click(button("Restart now")!);
    assert.deepEqual(calls, ["restart"]);
  });

  it("no pending restart: no blocker list, the restart button still there", async () => {
    await show({ ...pending, pendingRestart: null });
    assert.equal(text().includes("A restart is pending"), false);
    assert.ok(button("Restart agent host now"));
  });
});
