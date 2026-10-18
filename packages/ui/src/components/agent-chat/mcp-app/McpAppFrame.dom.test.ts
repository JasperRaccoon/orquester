/**
 * An MCP App's frame, mounted in jsdom against a fake API client: the host
 * survives a reconnect's client swap, the teardown goes out on unmount, a
 * refused app costs no request, a hidden tab's zero width is never reported,
 * and the app's shortcuts reach the app.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { McpAppReference } from "@orquester/api/agent-chat";

import { OrquesterProvider, type OrquesterProviderProps } from "../../../context/orquester-context";
import { releaseThreadStore, retainThreadStore } from "../../../lib/agent-chat/store";
import type { AgentChatTransport } from "../../../lib/agent-chat/transport";
import { McpAppFrame } from "./McpAppFrame";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "KeyboardEvent", "getComputedStyle"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

const unused = async (): Promise<never> => {
  throw new Error("Unexpected transport request");
};
const transport: AgentChatTransport = {
  stream: () => ({ lastSeq: 0, hostInstanceId: null, resetCursor() {}, retry() {}, close() {} }),
  command: unused,
  switchAccount: unused,
  switchProfile: unused,
  read: unused,
  readItem: unused,
  readHistory: unused,
  search: unused,
  turnDiff: unused,
  providers: unused,
  refreshProvider: unused,
  upload: unused,
  fetchAttachment: unused
};

const SESSION = "mcp-frame-session";

before(() => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "https://orq.example.com/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value:
        name === "getComputedStyle"
          ? dom.window.getComputedStyle.bind(dom.window)
          : (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  retainThreadStore(SESSION, { transport });
});

after(() => {
  releaseThreadStore(SESSION);
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/** A fake client: every call is logged under its label. */
function fakeApi(label: string, calls: string[]) {
  return {
    connection: { endpoint: "https://orq.example.com" },
    agentChat: transport,
    agentVisualUrl: async () => {
      calls.push(`${label}:mint`);
      return { src: "https://orq.example.com/api/agent-visuals/s/x-html?sig=1", expiresAt: Date.now() + 3_600_000 };
    },
    mcpAppRequest: async (_sessionId: string, _itemId: string, operation: string) => {
      calls.push(`${label}:${operation}`);
      if (operation === "tool-info") return { tool: { name: "show" }, modelContext: false, callable: true, readOnly: true };
      if (operation === "read-resource") return { contents: [] };
      return {};
    },
    agentChatItem: async () => {
      calls.push(`${label}:item`);
      return { item: { kind: "activity", payload: {} } };
    }
  };
}

const app = (extra: Partial<McpAppReference> = {}): McpAppReference => ({
  attachmentId: `${SESSION}-app-html`,
  server: "charts",
  tool: "show",
  resourceUri: "ui://charts/view.html",
  ...extra
});

let root: Root;
let attachment = 0;
beforeEach(() => {
  const mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
});

async function render(api: ReturnType<typeof fakeApi>, reference: McpAppReference): Promise<void> {
  await act(async () => {
    root.render(
      createElement(OrquesterProvider, {
        runtime: "web",
        useTitlebar: false,
        api,
        children: createElement(McpAppFrame, { sessionId: SESSION, itemId: "item-1", app: reference, readOnly: false })
      } as unknown as OrquesterProviderProps)
    );
  });
  // The mint, the tool info and the row settle; the frame mounts on them.
  for (let round = 0; round < 3; round += 1) await act(async () => new Promise((resolve) => setImmediate(resolve)));
}

/** The app's side of the bridge: what the host posts to its window, and a way to speak. */
function appWindow() {
  const frame = dom.window.document.querySelector("iframe");
  assert.ok(frame, "the frame mounted");
  const win = frame.contentWindow!;
  const posted: Array<{ id?: unknown; method?: string; result?: Record<string, unknown> }> = [];
  (win as unknown as { postMessage: (message: unknown) => void }).postMessage = (message) =>
    posted.push(message as never);
  const say = async (data: unknown) => {
    const event = new dom.window.Event("message");
    Object.defineProperty(event, "data", { value: data });
    Object.defineProperty(event, "source", { value: win });
    await act(async () => {
      dom.window.dispatchEvent(event);
      await new Promise((resolve) => setImmediate(resolve));
    });
  };
  return { frame, win, posted, say };
}

async function initialized(bridge: ReturnType<typeof appWindow>) {
  await bridge.say({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appCapabilities: {} } });
  await bridge.say({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
}

describe("an MCP App's frame", () => {
  it("keeps its host across a reconnect's new API client, and asks through the new one", async () => {
    const calls: string[] = [];
    const reference = app({ attachmentId: `${SESSION}-a${++attachment}-html` });
    await render(fakeApi("first", calls), reference);
    const bridge = appWindow();
    await initialized(bridge);
    await render(fakeApi("second", calls), reference);
    assert.ok(
      !bridge.posted.some((message) => message.method === "ui/resource-teardown"),
      "the live app was not torn down"
    );
    assert.equal(dom.window.document.querySelector("iframe"), bridge.frame, "the same document");
    await bridge.say({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://charts/data" } });
    assert.ok(calls.includes("second:read-resource"), calls.join(", "));
    assert.ok(!calls.includes("second:tool-info") && !calls.includes("second:item"), "nothing re-read on the swap");
    await act(async () => root.unmount());
  });

  it("sends its teardown on unmount", async () => {
    const calls: string[] = [];
    await render(fakeApi("first", calls), app({ attachmentId: `${SESSION}-a${++attachment}-html` }));
    const bridge = appWindow();
    await initialized(bridge);
    await act(async () => root.unmount());
    assert.ok(bridge.posted.some((message) => message.method === "ui/resource-teardown"));
  });

  it("never reports a hidden tab's zero width", async () => {
    const calls: string[] = [];
    await render(fakeApi("first", calls), app({ attachmentId: `${SESSION}-a${++attachment}-html` }));
    const bridge = appWindow();
    await initialized(bridge);
    const response = bridge.posted.find((message) => message.id === 1);
    const dimensions = (response?.result?.hostContext as { containerDimensions?: { width?: number } } | undefined)
      ?.containerDimensions;
    assert.ok(dimensions?.width !== undefined && dimensions.width > 0, JSON.stringify(dimensions));
    await act(async () => root.unmount());
  });

  it("refuses an app that reaches Orquester before asking anything", async () => {
    const calls: string[] = [];
    await render(
      fakeApi("first", calls),
      app({ attachmentId: `${SESSION}-a${++attachment}-html`, csp: { connectDomains: ["https://orq.example.com"] } })
    );
    assert.match(dom.window.document.body.textContent ?? "", /asks to connect to Orquester itself/);
    assert.deepEqual(calls, []);
    await act(async () => root.unmount());
  });

  it("tells the app its shortcuts, and replays one it passes on while focused", async () => {
    const calls: string[] = [];
    await render(fakeApi("first", calls), app({ attachmentId: `${SESSION}-a${++attachment}-html` }));
    const bridge = appWindow();
    await act(async () => {
      bridge.frame.dispatchEvent(new dom.window.Event("load"));
    });
    assert.ok(bridge.posted.some((message) => message.method === "orq/notifications/shortcuts"));
    const seen: string[] = [];
    dom.window.addEventListener("keydown", (event) => seen.push(`${event.ctrlKey ? "ctrl+" : ""}${event.key}`));
    const palette = { key: "k", code: "KeyK", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false };
    const keydown = { jsonrpc: "2.0", method: "orq/notifications/keydown", params: palette };
    await bridge.say(keydown);
    assert.deepEqual(seen, [], "not while the frame lacks focus");
    bridge.frame.focus();
    await bridge.say(keydown);
    await bridge.say({ ...keydown, params: { ...palette, key: "w", code: "KeyW" } });
    assert.deepEqual(seen, ["ctrl+k"], "only an allowed chord");
    await act(async () => root.unmount());
  });
});
