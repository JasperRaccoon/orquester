/**
 * Settings → Server → Remote access → Tailscale HTTPS in a DOM: the toggle,
 * the served address, the daemon's actionable problems and refusals.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TailscaleServeStatus } from "@orquester/api";

import { OrquesterProvider } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let TailscaleServeSetting: typeof import("./TailscaleServeSetting").TailscaleServeSetting;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "https://orq.example.com/" });
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
  ({ TailscaleServeSetting } = await import("./TailscaleServeSetting"));
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

afterEach(() => {
  act(() => root.unmount());
});

const doc = () => dom.window.document;
const text = () => doc().body.textContent ?? "";
const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
};
/** Let the loads and toggles settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
};

function render(api: Record<string, unknown>, node: ReactNode) {
  const client = api as unknown as ApiClient;
  act(() => root.render(createElement(OrquesterProvider, { runtime: "web", api: client, useTitlebar: false, children: node })));
}

describe("TailscaleServeSetting", () => {
  const status = (patch: Partial<TailscaleServeStatus> = {}): TailscaleServeStatus => ({
    available: true,
    dnsName: "box.tail1234.ts.net",
    httpsEnabled: true,
    enabled: false,
    active: false,
    url: "https://box.tail1234.ts.net/",
    otherTarget: null,
    problem: null,
    ...patch
  });
  const switchEl = () => doc().querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Tailscale HTTPS"]');

  it("turns serving on and shows the address", async () => {
    const calls: boolean[] = [];
    render(
      {
        getTailscaleServe: async () => status(),
        setTailscaleServe: async (enabled: boolean) => {
          calls.push(enabled);
          return status({ enabled, active: enabled });
        }
      },
      createElement(TailscaleServeSetting, { httpEnabled: true })
    );
    await settle();
    assert.equal(switchEl()?.disabled, false);
    await click(switchEl()!);
    await settle();
    assert.deepEqual(calls, [true]);
    assert.match(text(), /https:\/\/box\.tail1234\.ts\.net\//);
    assert.match(text(), /Serving/);
  });

  it("shows the fix and keeps the switch off when Tailscale cannot serve", async () => {
    render(
      {
        getTailscaleServe: async () =>
          status({ problem: { code: "https-disabled", message: "HTTPS certificates are off for your tailnet. Turn on HTTPS Certificates in the Tailscale admin console (DNS), then try again." } }),
        setTailscaleServe: async () => assert.fail("must not toggle")
      },
      createElement(TailscaleServeSetting, { httpEnabled: true })
    );
    await settle();
    assert.equal(switchEl()?.disabled, true);
    assert.match(text(), /Turn on HTTPS Certificates in the Tailscale admin console/);
  });

  it("shows the daemon's refusal", async () => {
    const { ApiError } = await import("../../lib/api-client");
    render(
      {
        getTailscaleServe: async () => status(),
        setTailscaleServe: async () => {
          throw new ApiError(409, "PUT", "/api/remote-access/tailscale-serve", {}, { code: "permission-denied", message: "Run `sudo tailscale set --operator=$USER` once." });
        }
      },
      createElement(TailscaleServeSetting, { httpEnabled: true })
    );
    await settle();
    await click(switchEl()!);
    await settle();
    assert.match(text(), /sudo tailscale set --operator/);
  });

  it("renders nothing against a daemon without the route", async () => {
    const { ApiError } = await import("../../lib/api-client");
    render(
      {
        getTailscaleServe: async () => {
          throw new ApiError(404, "GET", "/api/remote-access/tailscale-serve");
        }
      },
      createElement(TailscaleServeSetting, { httpEnabled: true })
    );
    await settle();
    assert.equal(text(), "");
  });
});
