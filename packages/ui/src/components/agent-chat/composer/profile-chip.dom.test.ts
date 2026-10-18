/**
 * The composer's Agent Profile chip in a DOM (agent profiles spec §5.3): it
 * names the thread's profile (or Global), lists Global then the profiles,
 * disables one not ready for the chat's agent with the reason, switches
 * through `onChange`, and is closed while the thread is busy.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionProfileSummary } from "@orquester/api";

import type { ProfileChipProps } from "./ProfileChip";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ProfileChip: typeof import("./ProfileChip").ProfileChip;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("min-width"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  });
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
  ({ ProfileChip } = await import("./ProfileChip"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const zero = { total: 0, enabled: 0 };
function profile(id: string, name: string, codex: "ready" | "preparing" | "failed"): SessionProfileSummary {
  return {
    id,
    name,
    description: "",
    revision: "1",
    createdAt: "t",
    updatedAt: "t",
    counts: { mcp: { total: 1, enabled: 1 }, skill: { total: 3, enabled: 3 }, plugin: zero, hook: zero, command: zero },
    hasInstructions: false,
    preparation: (["claude", "codex", "grok", "opencode"] as const).map((agent) => ({
      agent,
      state: agent === "codex" ? codex : ("ready" as const),
      updatedAt: "t",
      ...(agent === "codex" && codex === "failed" ? { reason: "no login" } : {})
    }))
  };
}

const PROFILES = [profile("p-dev", "Developer", "ready"), profile("p-ed", "Editor", "failed")];

describe("composer profile chip", () => {
  let root: Root;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
  });

  const render = async (props: Partial<ProfileChipProps> & { onChange: ProfileChipProps["onChange"] }) => {
    await act(async () => {
      root.render(
        createElement(ProfileChip, {
          agent: "codex",
          profiles: PROFILES,
          selectedId: null,
          canSwitch: true,
          ...props
        })
      );
    });
  };

  const trigger = () => document.querySelector<HTMLButtonElement>("[data-composer-profile-chip]")!;
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => {
      (element as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  it("names Global, lists the profiles, and disables one not ready for the chat's agent", async () => {
    const picked: (string | null)[] = [];
    await render({ onChange: (id) => picked.push(id) });
    assert.match(trigger().textContent ?? "", /Global/);
    await click(trigger());
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.match(rows[0]?.textContent ?? "", /^Global/, "Global first");
    assert.deepEqual(
      rows.slice(1).map((row) => row.getAttribute("data-profile-entry")),
      ["p-dev", "p-ed"],
      "then the profiles, by name"
    );
    const editor = document.querySelector<HTMLButtonElement>('[data-profile-entry="p-ed"]')!;
    assert.equal(editor.disabled, true);
    assert.match(editor.textContent ?? "", /Not ready for Codex: no login/);
    assert.match(document.querySelector('[data-profile-entry="p-dev"]')?.textContent ?? "", /3 skills · 1 MCP/);
    assert.match(document.body.textContent ?? "", /Switching restarts the agent/);

    await click(document.querySelector('[data-profile-entry="p-dev"]'));
    assert.deepEqual(picked, ["p-dev"]);
  });

  it("shows the thread's profile and switches back to Global", async () => {
    const picked: (string | null)[] = [];
    await render({ selectedId: "p-dev", onChange: (id) => picked.push(id) });
    assert.match(trigger().textContent ?? "", /Developer/);
    await click(trigger());
    const global = [...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent?.startsWith("Global"));
    await click(global);
    assert.deepEqual(picked, [null]);
  });

  it("is closed while the thread is busy, saying why", async () => {
    await render({ canSwitch: false, disabledReason: "Compacting…", onChange: () => undefined });
    assert.equal(trigger().disabled, true);
    assert.equal(trigger().title, "Compacting…");
  });
});
