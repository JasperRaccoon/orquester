/**
 * The host CPU/memory chip on a phone (jsdom has no media queries, so it reads
 * as one): the chip sits in the drawer's footer, and the drawer stays mounted
 * off-canvas, so it reads the host only while the drawer is open.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SystemResourcesResponse } from "@orquester/api";

// Loaded once the DOM globals exist: React DOM reads them when it loads.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let SystemStatusChip: typeof import("./SystemStatusChip").SystemStatusChip;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
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
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  ({ SystemStatusChip } = await import("./SystemStatusChip"));
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

const resources: SystemResourcesResponse = {
  supported: true,
  cpu: { percent: 12, cores: 8 },
  memory: { totalBytes: 16 * 2 ** 30, availableBytes: 8 * 2 ** 30, usedPercent: 50 },
  workspacesDisk: { totalBytes: 100 * 2 ** 30, freeBytes: 40 * 2 ** 30, usedPercent: 60, path: "/workspaces" }
};

describe("the host chip in the phone drawer", () => {
  let root: Root;
  let reads: number;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = useAppStore.getState();
    useAppStore.setState({ connectionStatus: "connected", sidebarDrawerOpen: false });
    reads = 0;
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useAppStore.setState(initial, true);
  });

  const api = {
    connection: { id: "c1", endpoint: "http://daemon", password: "" },
    transportKind: "http",
    systemResources: async () => {
      reads += 1;
      return resources;
    }
  };

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const chip = () => dom.window.document.querySelector('[aria-label^="Host: CPU"]');

  it("reads the host and shows CPU and memory once the drawer opens, and not before", async () => {
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: api as never,
          useTitlebar: false,
          children: createElement(SystemStatusChip)
        })
      );
    });
    await flush();
    assert.equal(reads, 0, "a closed drawer is off screen: nothing reads the host");
    assert.equal(chip(), null);

    await act(async () => useAppStore.setState({ sidebarDrawerOpen: true }));
    await flush();
    assert.equal(reads, 1);
    assert.equal(chip()?.getAttribute("aria-label"), "Host: CPU 12%, memory 50%");
  });

  it("stops reading once the daemon refuses the sign-in, instead of re-sending it every tick", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const refusing = {
        ...api,
        systemResources: async () => {
          reads += 1;
          throw Object.assign(new Error("GET /api/system/resources failed with status 429"), { status: 429 });
        }
      };
      useAppStore.setState({ sidebarDrawerOpen: true });
      await act(async () => {
        root.render(
          createElement(OrquesterProvider, {
            runtime: "web",
            api: refusing as never,
            useTitlebar: false,
            children: createElement(SystemStatusChip)
          })
        );
      });
      await flush();
      assert.equal(reads, 1);
      for (let tick = 0; tick < 3; tick += 1) {
        await act(async () => mock.timers.tick(3000));
        await flush();
      }
      assert.equal(reads, 1, "a refused credential is not sent again");
    } finally {
      mock.timers.reset();
    }
  });
});
