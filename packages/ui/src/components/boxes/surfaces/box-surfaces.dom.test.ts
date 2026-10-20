/**
 * The box surfaces in a DOM (Ephemeral AI VMs spec §8.3, §8.10, §9.3, §13.3):
 * a destroyed box project's row strikes its name and says Destroyed; a chat of
 * it shows the destroyed banner and a composer lock instead of the composer;
 * a temporary box's card offers Watch and Destroy; a config change card
 * expands a diff, flags executables, posts Approve and then shows its outcome
 * until dismissed.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  BOXES_CHANGED_EVENT,
  BOXES_CHANNEL,
  BOX_CONFIG_CHANGES_EVENT,
  boxRoutes,
  type BoxConfigChangeSet,
  type DecideBoxConfigChangeRequest,
  type BoxSummary,
  type EventMessage,
  type ProjectBoxInfo
} from "@orquester/api";

import { OrquesterProvider } from "../../../context/orquester-context";
import type { ApiClient } from "../../../lib/api-client";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let BoxChatPanel: typeof import("./BoxChatSurfaces").BoxChatPanel;
let BoxComposerLock: typeof import("./BoxChatSurfaces").BoxComposerLock;
let ProjectRow: typeof import("../../sidebar/WorkspaceProjects").ProjectRow;
let store: typeof import("../../../lib/boxes/store");

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "Event",
  "localStorage",
  "sessionStorage"
] as const;
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
  ({ BoxChatPanel, BoxComposerLock } = await import("./BoxChatSurfaces"));
  ({ ProjectRow } = await import("../../sidebar/WorkspaceProjects"));
  store = await import("../../../lib/boxes/store");
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const destroyedInfo: ProjectBoxInfo = {
  boxId: "box-1",
  kind: "linux",
  provider: "vultr",
  providerLabel: "Vultr",
  state: "destroyed",
  stateReason: "gone in the Vultr dashboard",
  destroyedReason: "provider-gone",
  hourlyUsd: 0.05,
  deadlineAt: null
};

const temporary: BoxSummary = {
  id: "tmp-1",
  purpose: "temporary",
  kind: "windows",
  provider: "hetzner",
  providerLabel: "Hetzner",
  region: "fsn1",
  regionLabel: "Falkenstein",
  size: "cx32",
  sizeLabel: "CX32",
  image: null,
  os: "win32",
  arch: "x64",
  state: "ready",
  stateReason: null,
  destroyedReason: null,
  hourlyUsd: 0.5,
  // Above what the clock adds while the test runs: the card shows the daemon's estimate.
  estimatedCostUsd: 5,
  createdAt: iso(-HOUR / 2),
  readyAt: iso(-HOUR / 4),
  deadlineAt: iso(HOUR + HOUR / 2),
  destroyedAt: null,
  connected: true,
  lastSeenAt: iso(0),
  project: null,
  threadId: "thread-1",
  purposeNote: "compile on Windows",
  setup: []
};

const pendingChange: BoxConfigChangeSet = {
  id: "cc-1",
  boxId: "box-1",
  threadId: "thread-1",
  createdAt: iso(0),
  decidedAt: null,
  state: "pending",
  files: [
    { path: "/h/.claude/hooks/pre.sh", change: "added", executable: true, diff: "+#!/bin/sh\n+echo hi", truncated: true, binary: false }
  ]
};

const boxesEvent = (type: string, payload: unknown) =>
  ({ channel: BOXES_CHANNEL, type, payload, timestamp: iso(0) }) as unknown as EventMessage;

describe("box surfaces", () => {
  let root: Root;
  let posts: { path: string; body: unknown }[];

  // The boxes store's client call: a decision answers with the decided set.
  const fakeApi = {
    decideBoxConfigChange: async (id: string, body: DecideBoxConfigChangeRequest) => {
      posts.push({ path: boxRoutes.configChange(id), body });
      return { change: { ...pendingChange, state: "approved", decidedAt: iso(0) } };
    }
  } as unknown as ApiClient;

  const render = async (child: ReturnType<typeof createElement>) => {
    await act(async () => {
      root.render(createElement(OrquesterProvider, { runtime: "web", api: fakeApi, useTitlebar: false, children: child }));
    });
  };
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await act(async () => undefined);
  };
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

  beforeEach(() => {
    posts = [];
    store.resetBoxes();
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("strikes a destroyed box project's name and says Destroyed, with the reason on hover", async () => {
    await render(
      createElement(ProjectRow, {
        project: { name: "app", workspace: "ws", path: "/w/ws/app", box: destroyedInfo },
        active: false,
        tempMarker: false,
        onOpen: () => {}
      })
    );
    const name = [...document.querySelectorAll("span")].find((s) => s.textContent === "app");
    assert.match(name?.className ?? "", /line-through/);
    const badge = document.querySelector<HTMLElement>("[data-box-badge]");
    assert.equal(badge?.textContent, "Destroyed");
    assert.match(badge?.title ?? "", /outside Orquester \(gone in the Vultr dashboard\)/);
  });

  it("shows a destroyed box chat's banner and the composer lock", async () => {
    await render(
      createElement(
        "div",
        null,
        createElement(BoxChatPanel, { sessionId: "thread-9", view: { info: destroyedInfo, box: null, setupStep: null } }),
        createElement(BoxComposerLock, { reason: "The VM was destroyed; this chat is read-only." })
      )
    );
    const banner = document.querySelector<HTMLElement>('[role="alert"][data-box-notice="destroyed"]');
    assert.ok(banner);
    assert.match(
      banner.textContent ?? "",
      /The VM was destroyed outside Orquester \(gone in the Vultr dashboard\)\. The transcript stays readable; you can't send new messages\. Unpushed changes are lost\./
    );
    assert.match(document.querySelector("[data-box-chip]")?.textContent ?? "", /^Linux VM · Vultr$/);
    const lock = document.querySelector<HTMLElement>("[data-box-composer-lock]");
    assert.match(lock?.textContent ?? "", /read-only/);
    assert.equal(document.querySelector("textarea"), null, "no composer to type into");
  });

  it("lists the chat's temporary box with Watch and Destroy, and its pending config change", async () => {
    await render(createElement(BoxChatPanel, { sessionId: "thread-1", view: null }));
    assert.equal(document.querySelector("[data-box-chat-panel]"), null, "nothing to show yet");

    await act(async () => {
      store.applyBoxesEvent(boxesEvent(BOXES_CHANGED_EVENT, { boxes: [temporary] }));
      store.applyBoxesEvent(boxesEvent(BOX_CONFIG_CHANGES_EVENT, { changes: [pendingChange] }));
    });
    await flush();

    const card = document.querySelector<HTMLElement>('[data-temporary-box="tmp-1"]');
    assert.ok(card);
    assert.match(card.textContent ?? "", /Windows — compile on Windows/);
    assert.match(card.textContent ?? "", /\$5\.00 so far · \$0\.50\/h/);
    assert.match(card.textContent ?? "", /1h \d+m left/);
    assert.equal(button("Watch")?.disabled, false);
    assert.equal(button("Destroy")?.disabled, false);

    const changeCard = document.querySelector<HTMLElement>('[data-box-config-change="cc-1"]');
    assert.ok(changeCard);
    assert.match(changeCard.textContent ?? "", /executable/);
    assert.match(changeCard.textContent ?? "", /1 file · 1 executable/);

    // The diff opens on its row, with the truncation note under it.
    const row = [...changeCard.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("pre.sh"));
    await act(async () => row?.click());
    assert.match(changeCard.querySelector("pre")?.textContent ?? "", /echo hi/);
    assert.match(changeCard.textContent ?? "", /The diff is truncated/);

    await act(async () => button("Approve")?.click());
    await flush();
    assert.deepEqual(posts, [{ path: boxRoutes.configChange("cc-1"), body: { decision: "approve" } }]);
    // Decided here: it stays with its outcome until dismissed.
    assert.match(document.querySelector('[data-box-config-change="cc-1"]')?.textContent ?? "", /Approved/);
    await act(async () => button("Dismiss")?.click());
    await flush();
    assert.equal(document.querySelector('[data-box-config-change="cc-1"]'), null);
  });
});
