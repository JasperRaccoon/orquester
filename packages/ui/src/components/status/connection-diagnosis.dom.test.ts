/**
 * The connection diagnosis in a DOM: the toast names what failed and offers its
 * fix (Retry, Sign in), Details runs the live checks, and Copy diagnostics
 * copies a report without the credential.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { OrquesterProvider } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";
import { recordConnectionFailure, resetConnectionLog } from "../../lib/connection/connection-log";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ConnectionStatusToast: typeof import("./ConnectionStatusToast").ConnectionStatusToast;
let useAppStore: typeof import("../../store/app").useAppStore;

const CREDENTIAL = Buffer.from("mapacho:$2a$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123").toString("base64");
const ENDPOINT = "https://orq.example.com";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "WebSocket"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let clipboard: string[] = [];
let sockets: string[] = [];

/** A socket that never gets through: closes with 1006, as a blocked upgrade does. */
class ClosingSocket {
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    sockets.push(url);
    setTimeout(() => this.onclose?.({ code: 1006 }), 0);
  }
  close(): void {}
}

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: `${ENDPOINT}/` });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text: string) => void clipboard.push(text) },
    configurable: true
  });
  const values: Record<string, unknown> = { ...(dom.window as unknown as Record<string, unknown>), WebSocket: ClosingSocket };
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ConnectionStatusToast } = await import("./ConnectionStatusToast"));
  ({ useAppStore } = await import("../../store/app"));
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
let initial: ReturnType<typeof useAppStore.getState>;

beforeEach(() => {
  initial = { ...useAppStore.getState() };
  const mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  clipboard = [];
  sockets = [];
  resetConnectionLog();
});

afterEach(() => {
  act(() => root.unmount());
  useAppStore.setState(initial, true);
});

const doc = () => dom.window.document;
const text = () => doc().body.textContent ?? "";
const button = (label: string) =>
  [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
};
/** Let probes, timers and promises settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
};

function render(api: Partial<ApiClient> & Record<string, unknown>, node: ReactNode) {
  const client = { transportKind: "http", connection: { id: "vps", password: CREDENTIAL }, ...api } as unknown as ApiClient;
  useAppStore.setState({
    api: client,
    connections: [{ id: "vps", name: "vps", kind: "remote", endpoint: ENDPOINT, status: "error", password: CREDENTIAL }],
    activeConnectionId: "vps",
    authPrompt: null
  });
  act(() => root.render(createElement(OrquesterProvider, { runtime: "web", api: client, useTitlebar: false, children: node })));
}

describe("ConnectionStatusToast", () => {
  it("names the failure, retries, and copies a redacted report with the live checks", async () => {
    let connects = 0;
    useAppStore.setState({ connectionStatus: "error", reconnectAttempt: 0, connectionError: null, connect: async () => void (connects += 1) });
    recordConnectionFailure({ kind: "refused", detail: `connect ECONNREFUSED (Bearer ${CREDENTIAL})`, at: Date.now() });
    render(
      {
        health: async () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
        }
      },
      createElement(ConnectionStatusToast)
    );
    assert.match(text(), /vps refused the connection/);
    assert.ok(!text().includes("Disconnected"));

    await click(button("Retry")!);
    assert.equal(connects, 1);

    await click(button("Details")!);
    await settle();
    assert.match(text(), /Nothing listens on that port/);
    assert.match(text(), /HTTP:.*GET \/health failed/);
    assert.match(text(), /WebSocket:.*closed before opening \(code 1006\)/);
    assert.deepEqual(sockets, [`wss://orq.example.com/ws?token=${encodeURIComponent(CREDENTIAL)}`]);
    assert.ok(!text().includes(CREDENTIAL), "the credential never renders");

    await click(button("Copy diagnostics")!);
    assert.equal(clipboard.length, 1);
    const report = clipboard[0]!;
    assert.match(report, /^Orquester connection diagnostics/);
    assert.match(report, /Server: vps — https:\/\/orq\.example\.com\//);
    assert.match(report, /HTTP check: FAILED/);
    assert.match(report, /WebSocket check: FAILED — the WebSocket closed before opening \(code 1006\)/);
    assert.match(report, /refused {2}connect ECONNREFUSED/);
    assert.ok(!report.includes(CREDENTIAL), report);
    assert.ok(!report.includes(encodeURIComponent(CREDENTIAL)), report);
    assert.match(text(), /Copied/);
  });

  it("a refused sign-in offers Sign in, which opens the sign-in prompt", async () => {
    useAppStore.setState({ connectionStatus: "error", reconnectAttempt: 0, connectionError: "Incorrect username or password." });
    recordConnectionFailure({ kind: "unauthorized", status: 401, detail: "401", at: Date.now() });
    render({ health: async () => ({ ok: true }) }, createElement(ConnectionStatusToast));
    assert.match(text(), /Sign in to vps again/);
    await click(button("Sign in")!);
    assert.deepEqual(useAppStore.getState().authPrompt, { connectionId: "vps" });
  });

  it("stays hidden while connected and healthy, and behind the sign-in prompt", () => {
    useAppStore.setState({ connectionStatus: "connected", reconnectAttempt: 0 });
    render({}, createElement(ConnectionStatusToast));
    assert.equal(text(), "");
    act(() => useAppStore.setState({ connectionStatus: "error", authPrompt: { connectionId: "vps" } }));
    assert.equal(text(), "");
  });
});
