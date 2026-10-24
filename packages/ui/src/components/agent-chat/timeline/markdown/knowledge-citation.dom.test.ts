/**
 * Knowledge citations in an assistant message, in a DOM: the URL filter keeps
 * exactly the citation scheme; a citation renders as a chip (a button with no
 * href) that opens the entry in the Knowledge tab and never navigates; whether
 * the entry exists is asked on hover, once per entry, and a deleted one is
 * struck through; with the plugin off it is plain text.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { knowledgePlugin } from "../../../../lib/knowledge/fixtures.test-helpers";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../../../store/app").useAppStore;
let resetKnowledge: typeof import("../../../../lib/knowledge/store").resetKnowledge;
let deleteKnowledgeEntry: typeof import("../../../../lib/knowledge/store").deleteKnowledgeEntry;
let resetKnowledgeCitations: typeof import("../../../../lib/knowledge/citations").resetKnowledgeCitations;
let markdown: typeof import("./ChatMarkdown");
let ApiError: typeof import("../../../../lib/api-client").ApiError;

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
      (name === "PointerEvent" ? (dom.window as unknown as Record<string, unknown>).MouseEvent : undefined);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useAppStore } = await import("../../../../store/app"));
  ({ resetKnowledge, deleteKnowledgeEntry } = await import("../../../../lib/knowledge/store"));
  ({ resetKnowledgeCitations } = await import("../../../../lib/knowledge/citations"));
  markdown = await import("./ChatMarkdown");
  ({ ApiError } = await import("../../../../lib/api-client"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const LIVE = "ke_aaaaaaaaaaaa";
const GONE = "ke_bbbbbbbbbbbb";
const PROJECT = { name: "app", path: "/w/ws/app", workspace: "ws" };

describe("the chat's URL filter", () => {
  it("keeps a citation link and the usual schemes, and nothing else of the custom scheme", () => {
    const t = (url: string, key = "href") => markdown.chatUrlTransform(url, key, {} as never);
    assert.equal(t(`orquester-knowledge:entry/${LIVE}`), `orquester-knowledge:entry/${LIVE}`);
    assert.equal(t("https://example.com/a"), "https://example.com/a");
    assert.equal(t("src/index.ts"), "src/index.ts");
    assert.equal(t("javascript:alert(1)"), "");
    assert.equal(t("orquester-knowledge:entry/../../etc"), "");
    assert.equal(t("orquester-knowledge:concept/tactic-x"), "");
    assert.equal(t(`orquester-knowledge:entry/${LIVE}`, "src"), "", "never an image source");
  });
});

describe("knowledge citations in a message", () => {
  let root: Root;
  let reads: string[];
  let initial: ReturnType<typeof useAppStore.getState>;

  const api = {
    connection: { id: "c1" },
    getKnowledgeItem: async (id: string) => {
      reads.push(id);
      if (id === GONE) throw new ApiError(404, "GET", `/api/knowledge/items/${id}`, {}, { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
      return { kind: "entry" };
    },
    deleteKnowledgeEntry: async () => ({}),
    listKnowledgeCollections: async () => ({ collections: [], unfiledCount: 0, totalEntries: 0 })
  };
  const readItem = api.getKnowledgeItem;

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    reads = [];
    api.getKnowledgeItem = readItem;
    resetKnowledge();
    resetKnowledgeCitations();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetKnowledge();
    resetKnowledgeCitations();
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };

  const TEXT = [
    `Use alternatives pages [Alternatives pages · @hridoyreh](orquester-knowledge:entry/${LIVE}).`,
    "",
    `Also [Old note](orquester-knowledge:entry/${GONE}) and [again](orquester-knowledge:entry/${LIVE}).`,
    "",
    "See [the docs](https://example.com/docs)."
  ].join("\n");

  const show = async (on: boolean) => {
    useAppStore.setState({ api: api as never, plugins: [knowledgePlugin(on)], currentProject: PROJECT as never });
    await act(async () => root.render(createElement(markdown.ChatMarkdown, { text: TEXT })));
    await settle();
  };

  const doc = () => dom.window.document;
  const chips = (id: string) => [...doc().querySelectorAll<HTMLButtonElement>(`button[data-knowledge-citation="${id}"]`)];
  const fire = async (element: Element, type: string, Ctor: typeof MouseEvent = dom.window.MouseEvent) => {
    let event!: MouseEvent;
    await act(async () => {
      event = new Ctor(type, { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    });
    await settle();
    return event;
  };

  it("renders each citation as a chip with its text, not a link", async () => {
    await show(true);
    const [chip] = chips(LIVE);
    assert.ok(chip, "a chip");
    assert.equal(chip.tagName, "BUTTON");
    assert.equal(chip.getAttribute("type"), "button");
    assert.equal(chip.closest("a"), null, "not inside a link");
    assert.equal(chip.textContent, "Alternatives pages · @hridoyreh");
    assert.ok(chip.querySelector("svg"), "the knowledge icon");
    assert.equal(chips(LIVE).length, 2);
    assert.equal(doc().querySelectorAll('a[href^="orquester-knowledge:"]').length, 0, "no anchor carries the scheme");
    assert.ok(doc().querySelector('a[href="https://example.com/docs"]'), "other links are unchanged");
    assert.deepEqual(reads, [], "nothing is read on render");
  });

  it("a click opens the entry in the Knowledge tab and does not navigate", async () => {
    await show(true);
    const event = await fire(chips(LIVE)[0]!, "click");
    assert.equal(event.defaultPrevented, true);
    assert.equal(dom.window.location.href, "http://localhost/");
    const tab = useAppStore.getState().knowledgeTabsByProject[PROJECT.path]?.[0];
    assert.equal(tab?.focus?.kind, "entry");
    assert.equal(tab?.focus?.id, LIVE);
    assert.equal(useAppStore.getState().activeTabByProject[PROJECT.path], tab?.id);
  });

  it("asks whether an entry exists on hover, once per entry, and strikes a deleted one through", async () => {
    await show(true);
    const pointer = dom.window.PointerEvent ?? dom.window.MouseEvent;
    // React's onPointerEnter listens for pointerover.
    await fire(chips(GONE)[0]!, "pointerover", pointer as typeof MouseEvent);
    assert.deepEqual(reads, [GONE]);
    const gone = chips(GONE)[0]!;
    assert.equal(gone.dataset.state, "deleted");
    assert.match(gone.textContent!, /Old note\s*deleted/);
    assert.ok(gone.querySelector(".line-through"));

    await fire(chips(LIVE)[0]!, "pointerover", pointer as typeof MouseEvent);
    await fire(chips(LIVE)[1]!, "pointerover", pointer as typeof MouseEvent);
    await fire(chips(LIVE)[0]!, "click");
    assert.deepEqual(reads, [GONE, LIVE], "one read per entry");
    assert.ok(chips(LIVE).every((chip) => chip.dataset.state === "exists"));
  });

  it("asks again when the entry is deleted from this client", async () => {
    await show(true);
    const pointer = dom.window.PointerEvent ?? dom.window.MouseEvent;
    await fire(chips(LIVE)[0]!, "pointerover", pointer as typeof MouseEvent);
    assert.equal(chips(LIVE)[0]!.dataset.state, "exists");
    api.getKnowledgeItem = async (id: string) => {
      reads.push(id);
      throw new ApiError(404, "GET", `/api/knowledge/items/${id}`, {}, { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
    };
    await act(async () => {
      await deleteKnowledgeEntry(api as never, LIVE);
    });
    await settle();
    assert.equal(chips(LIVE)[0]!.dataset.state, "deleted");
  });

  it("is the plain link text while the plugin is off", async () => {
    await show(false);
    assert.equal(chips(LIVE).length, 0);
    assert.equal(doc().querySelectorAll("a[href^='orquester-knowledge:'], a[href='']").length, 0);
    assert.match(doc().body.textContent!, /Use alternatives pages Alternatives pages · @hridoyreh\./);
    const span = doc().querySelector(`[data-knowledge-citation-text="${LIVE}"]`);
    assert.equal(span?.tagName, "SPAN");
  });
});
