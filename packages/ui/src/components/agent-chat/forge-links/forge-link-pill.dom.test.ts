/**
 * A forge link pill in a DOM: a real new-tab link with the short label, no
 * preview read until it is hovered (jsdom has no IntersectionObserver), the
 * hover card with the daemon's details and GitHub's state colour once read,
 * nothing for a touch, Escape to dismiss, and a plain styled link when the
 * read fails.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { parseForgeLink, type ForgeLink, type GitHubLinkPreview } from "@orquester/api";

import type { ApiClient } from "../../../lib/api-client";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ForgeLinkPill: typeof import("./ForgeLinkPill").ForgeLinkPill;
let OrquesterProvider: typeof import("../../../context/orquester-context").OrquesterProvider;

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
  "PointerEvent",
  "FocusEvent",
  "Event",
  "localStorage",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      (dom.window as unknown as Record<string, unknown>)[name] ??
      // Older jsdom builds lack PointerEvent; a MouseEvent carries what React reads.
      (name === "PointerEvent" ? (dom.window as unknown as Record<string, unknown>).MouseEvent : undefined);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ForgeLinkPill } = await import("./ForgeLinkPill"));
  ({ OrquesterProvider } = await import("../../../context/orquester-context"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const PR_URL = "https://github.com/acme/app/pull/12";

const MERGED: GitHubLinkPreview = {
  kind: "pull",
  owner: "acme",
  repo: "app",
  number: 12,
  url: PR_URL,
  title: "Teach the parser about anchors",
  state: "merged",
  author: "octocat",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  closedAt: "2026-10-02T00:00:00Z",
  mergedAt: "2026-10-02T00:00:00Z",
  comments: 3,
  headRef: "anchors",
  baseRef: "main",
  headLabel: null,
  additions: 40,
  deletions: 2,
  changedFiles: 3,
  checks: null
};

function link(href: string): ForgeLink {
  const parsed = parseForgeLink(href);
  assert.ok(parsed, href);
  return parsed;
}

describe("forge link pill", () => {
  let root: Root;
  let calls: Array<{ url: string; projectPath: string | null | undefined }>;
  let answer: () => Promise<{ preview: GitHubLinkPreview }>;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
    answer = async () => ({ preview: MERGED });
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
  });

  const render = async (element: ReturnType<typeof createElement>) => {
    // A fresh client per test: the preview store is per client.
    const api = {
      getGitHubLinkPreview: (url: string, projectPath?: string | null) => {
        calls.push({ url, projectPath });
        return answer();
      }
    } as unknown as ApiClient;
    await act(async () => {
      root.render(createElement(OrquesterProvider, { runtime: "web" as never, api, useTitlebar: false, children: element }));
    });
  };

  const pill = () => document.querySelector<HTMLAnchorElement>("a[data-forge-link]")!;
  const card = () => document.querySelector<HTMLElement>("[data-forge-link-card]");
  const hover = async (pointerType: string) => {
    await act(async () => {
      const event = new PointerEvent("pointerover", { bubbles: true, pointerType } as PointerEventInit);
      // jsdom's stand-in may drop `pointerType` from the init; React reads it off the event.
      if (event.pointerType !== pointerType) Object.defineProperty(event, "pointerType", { value: pointerType });
      pill().dispatchEvent(event);
    });
    await act(async () => {
      mock.timers.tick(400);
    });
    // Let the preview read settle.
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  };

  it("is a real new-tab link with the short label, and reads nothing until hovered", async () => {
    await render(createElement(ForgeLinkPill, { link: link(PR_URL), projectPath: "/w/ws/app" }));
    const anchor = pill();
    assert.equal(anchor.getAttribute("href"), PR_URL);
    assert.equal(anchor.getAttribute("target"), "_blank");
    assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
    assert.equal(anchor.dataset.forgeLink, "pull");
    assert.equal(anchor.dataset.forgeState, "neutral");
    assert.match(anchor.textContent ?? "", /acme\/app#12/);
    assert.equal(calls.length, 0);
    assert.ok(card() === null, "the preview card is absent");
  });

  it("drops owner/repo for a link into the project's own repo", async () => {
    const { useAppStore } = await import("../../../store/app");
    const previous = useAppStore.getState().projects;
    useAppStore.setState({ projects: [{ name: "app", workspace: "ws", path: "/w/ws/app", repoKey: "github.com/acme/app" }] });
    try {
      await render(createElement(ForgeLinkPill, { link: link(PR_URL), projectPath: "/w/ws/app" }));
      assert.equal(pill().textContent, "#12");
      await render(createElement(ForgeLinkPill, { link: link("https://github.com/other/lib/pull/12"), projectPath: "/w/ws/app" }));
      assert.equal(pill().textContent, "other/lib#12");
    } finally {
      useAppStore.setState({ projects: previous });
    }
  });

  it("hover opens the card, reads the preview once, and takes the merged colour", async () => {
    await render(createElement(ForgeLinkPill, { link: link(PR_URL), projectPath: "/w/ws/app" }));
    await hover("mouse");
    assert.deepEqual(calls, [{ url: PR_URL, projectPath: "/w/ws/app" }]);
    const shown = card();
    assert.ok(shown, "the card is open");
    assert.equal(shown.getAttribute("role"), "tooltip");
    assert.equal(pill().getAttribute("aria-describedby"), shown.id);
    assert.match(shown.textContent ?? "", /Teach the parser about anchors/);
    assert.match(shown.textContent ?? "", /Merged/);
    assert.match(shown.textContent ?? "", /octocat/);
    assert.match(shown.textContent ?? "", /main ← anchors/);
    assert.match(shown.textContent ?? "", /Open on GitHub/);
    const open = shown.querySelector<HTMLAnchorElement>("a");
    assert.equal(open?.getAttribute("href"), PR_URL);
    assert.equal(open?.getAttribute("rel"), "noopener noreferrer");
    assert.equal(pill().dataset.forgeState, "merged");
    assert.match(pill().textContent ?? "", /\(Merged\)/, "the state is spoken, not only coloured");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.ok(card() === null, "Escape dismisses the card");
  });

  it("a touch does not open the card in the way of the tap", async () => {
    await render(createElement(ForgeLinkPill, { link: link(PR_URL) }));
    await hover("touch");
    assert.ok(card() === null, "the preview card is absent");
    assert.equal(calls.length, 0);
  });

  it("keeps the author's text, and stays a plain styled link when the read fails", async () => {
    answer = async () => {
      throw Object.assign(new Error("rate limited"), { status: 429, body: { code: "RATE_LIMITED", retryAfterMs: 60_000 } });
    };
    await render(createElement(ForgeLinkPill, { link: link(PR_URL) }, "the parser fix"));
    assert.match(pill().textContent ?? "", /the parser fix/);
    assert.doesNotMatch(pill().textContent ?? "", /acme\/app#12/);
    await hover("mouse");
    assert.equal(pill().dataset.forgeState, "neutral");
    assert.match(card()?.textContent ?? "", /rate limit/);
    assert.match(card()?.textContent ?? "", /Pull request acme\/app#12/);
  });

  it("never reads links that have no preview, but still shows their card", async () => {
    await render(createElement(ForgeLinkPill, { link: link("https://github.com/acme/app/blob/main/src/a.ts#L3-L9") }));
    assert.match(pill().textContent ?? "", /app › src\/a\.ts#L3-9/);
    await hover("mouse");
    assert.equal(calls.length, 0);
    assert.match(card()?.textContent ?? "", /File src\/a\.ts#L3-9 at main in acme\/app/);
    assert.doesNotMatch(card()?.textContent ?? "", /Loading/);
  });
});
