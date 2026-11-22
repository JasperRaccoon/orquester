/**
 * Settings → Server's tailnet address in a DOM: a refused setup shows the problem's fix, a served
 * address shows with its QR code, and the operator grant is offered only while serve needs sudo.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TailnetHttpsStatus } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let TailnetSettings: typeof import("./TailnetSettings").TailnetSettings;
let resetTailnet: typeof import("../../lib/tailnet/store").resetTailnet;
let useAppStore: typeof import("../../store/app").useAppStore;
let ApiError: typeof import("../../lib/api-client").ApiError;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ TailnetSettings } = await import("./TailnetSettings"));
  ({ resetTailnet } = await import("../../lib/tailnet/store"));
  ({ useAppStore } = await import("../../store/app"));
  ({ ApiError } = await import("../../lib/api-client"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const status = (patch: Partial<TailnetHttpsStatus> = {}): TailnetHttpsStatus => ({
  available: true,
  url: null,
  operatorOk: false,
  serveState: "off",
  port: 10000,
  checkedAt: "2026-11-22T10:00:00.000Z",
  ...patch
});

describe("TailnetSettings", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    initial = { ...useAppStore.getState() };
    resetTailnet();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetTailnet();
  });

  const text = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

  it("a refused setup names the fix; a served address shows with its QR code; the operator grant goes once allowed", async () => {
    let enableAnswers = 0;
    const api = {
      getTailnetHttps: async () => status(),
      listTailnetPreviews: async () => [],
      enableTailnetHttps: async () => {
        enableAnswers += 1;
        if (enableAnswers === 1) {
          throw new ApiError(409, "POST", "/api/tailnet/https", {}, {
            code: "TAILNET_PROBLEM",
            message: "HTTPS certificates are off for this tailnet.",
            problem: { code: "tailscale-https-disabled", message: "HTTPS certificates are off for this tailnet.", fix: "Turn on HTTPS Certificates on the DNS page of the Tailscale admin console." }
          });
        }
        return status({ serveState: "serving", url: "https://pc.tail1.ts.net:10000" });
      },
      setTailnetOperator: async () => status({ serveState: "serving", url: "https://pc.tail1.ts.net:10000", operatorOk: true })
    };
    useAppStore.setState({ api: api as never, connectionStatus: "connected" } as never);
    await act(async () => root.render(createElement(TailnetSettings)));
    assert.ok(button("Allow without sudo"), "serve needs sudo: the grant is offered");

    await act(async () => button("Set up")!.click());
    assert.match(text(), /Turn on HTTPS Certificates on the DNS page/);

    await act(async () => button("Set up")!.click());
    assert.match(text(), /https:\/\/pc\.tail1\.ts\.net:10000/);
    assert.ok(dom.window.document.querySelector('svg[aria-label="QR code for https://pc.tail1.ts.net:10000"]'));
    assert.doesNotMatch(text(), /Turn on HTTPS Certificates/);

    await act(async () => button("Allow without sudo")!.click());
    assert.equal(button("Allow without sudo"), undefined);
  });
});
