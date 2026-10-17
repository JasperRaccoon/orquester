/**
 * Settings → Plugins in a DOM: every plugin's toggle turns it on or off for
 * the whole server (`setPluginEnabled`); turning tsc-rs on asks first.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { PluginId, PluginInfo, TsCheckerEngine } from "@orquester/api";

import { useAppStore } from "../../store/app";
import { FIRST_ENABLE_MESSAGE } from "./plugins.logic";
import { PluginsSettings } from "./PluginsSettings";

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

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "ts-rust",
    name: "Better TS Typecheck",
    description: "Runs tsc-rs instead of tsc.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community",
    scope: "global",
    updates: true,
    platform: "supported",
    enabled: false,
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle",
    ...overrides
  };
}

const whiteboard = (overrides: Partial<PluginInfo> = {}): PluginInfo =>
  plugin({
    id: "excalidraw",
    name: "Excalidraw Whiteboard",
    description: "Sketch diagrams.",
    updates: false,
    ...overrides
  });

describe("PluginsSettings toggles", () => {
  let root: Root;
  let calls: Array<[PluginId, boolean | TsCheckerEngine]>;
  const initial = { ...useAppStore.getState() };

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
  });

  const show = (plugins: PluginInfo[]) => {
    const api = {
      setPluginEnabled: async (id: PluginId, enabled: boolean) => {
        calls.push([id, enabled]);
        return plugins.find((p) => p.id === id) ? { ...plugins.find((p) => p.id === id)!, enabled } : null;
      },
      setPluginEngine: async (id: PluginId, engine: TsCheckerEngine) => {
        calls.push([id, engine]);
        return plugins.find((p) => p.id === id) ? { ...plugins.find((p) => p.id === id)!, engine } : null;
      }
    };
    useAppStore.setState({
      api: api as never,
      connectionStatus: "connected",
      plugins,
      loadPlugins: async () => {}
    } as never);
    act(() => root.render(createElement(PluginsSettings)));
  };

  const document = () => dom.window.document;
  const switchFor = (name: string) => {
    const found = document().querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="Enable ${name}"]`);
    assert.ok(found, `a switch for ${name}`);
    return found;
  };
  const button = (text: string) =>
    [...document().querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  it("turning tsc-rs on asks first, then turns it on for the whole server", async () => {
    show([plugin()]);
    await click(switchFor("Better TS Typecheck"));
    assert.deepEqual(calls, [], "nothing is sent before the confirmation");
    assert.ok(document().body.textContent?.includes(FIRST_ENABLE_MESSAGE));

    const confirm = button("Confirm");
    assert.ok(confirm, "the confirmation dialog is open");
    await click(confirm);
    assert.deepEqual(calls, [["ts-rust", true]]);
    assert.equal(useAppStore.getState().plugins?.[0]?.enabled, true);
  });

  it("cancelling the confirmation sends nothing", async () => {
    show([plugin()]);
    await click(switchFor("Better TS Typecheck"));
    await click(button("Cancel")!);
    assert.deepEqual(calls, []);
  });

  it("turning tsc-rs off goes ahead without asking", async () => {
    show([plugin({ enabled: true })]);
    await click(switchFor("Better TS Typecheck"));
    assert.equal(button("Confirm"), undefined);
    assert.deepEqual(calls, [["ts-rust", false]]);
  });

  it("choosing the other engine sends it at once; the active one sends nothing", async () => {
    const engines: NonNullable<PluginInfo["engines"]> = (["tsrs", "tsc-rs"] as const).map((id) => ({
      id,
      label: id,
      description: `${id} engine`,
      source: { label: id, url: `https://example.com/${id}` },
      platform: "supported" as const
    }));
    show([plugin({ enabled: true, engine: "tsrs", engines })]);
    const radio = (label: string) =>
      [...document().querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Engine"] button[role="radio"]')].find(
        (b) => b.textContent?.startsWith(label)
      )!;
    await click(radio("tsrs"));
    assert.deepEqual(calls, []);
    await click(radio("tsc-rs"));
    assert.equal(button("Confirm"), undefined, "no confirmation for an engine switch");
    assert.deepEqual(calls, [["ts-rust", "tsc-rs"]]);
    assert.equal(useAppStore.getState().plugins?.[0]?.engine, "tsc-rs");
    assert.equal(radio("tsc-rs").getAttribute("aria-checked"), "true");
  });

  it("a bundled plugin is switched at once", async () => {
    show([plugin({ enabled: true }), whiteboard()]);
    await click(switchFor("Excalidraw Whiteboard"));
    assert.deepEqual(calls, [["excalidraw", true]]);
  });
});
