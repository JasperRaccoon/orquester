/**
 * Knowledge citations in an assistant message, in a DOM: the URL filter keeps
 * exactly the citation scheme; a citation renders as a chip (a button with no
 * href) that opens the entry in the Knowledge view and never navigates; whether
 * the entry exists is asked on hover, once per entry, and a deleted one is
 * struck through; with the plugin off it is plain text.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { collection, collections, entry, knowledgePlugin } from "../../../../lib/knowledge/fixtures.test-helpers";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../../../store/app").useAppStore;
let resetKnowledge: typeof import("../../../../lib/knowledge/store").resetKnowledge;
let deleteKnowledgeEntry: typeof import("../../../../lib/knowledge/store").deleteKnowledgeEntry;
let knowledgeStore: typeof import("../../../../lib/knowledge/store").knowledgeStore;
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
  ({ resetKnowledge, deleteKnowledgeEntry, knowledgeStore } = await import("../../../../lib/knowledge/store"));
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

  it("refuses every near-citation: case, whitespace, controls, encodings, smuggling, length", () => {
    const t = (url: string, key = "href") => markdown.chatUrlTransform(url, key, {} as never);
    const refused = [
      `ORQUESTER-KNOWLEDGE:entry/${LIVE}`,
      `Orquester-Knowledge:entry/${LIVE}`,
      `orquester-knowledge:Entry/${LIVE}`,
      "orquester-knowledge:entry/KE_AAAAAAAAAAAA",
      ` orquester-knowledge:entry/${LIVE}`,
      `orquester-knowledge:entry/${LIVE} `,
      `orquester-knowledge:entry/${LIVE}\n`,
      `orquester-knowledge:entry/${LIVE}%0A`,
      `orquester-knowledge:entry/${LIVE}\u0000`,
      `\torquester-knowledge:entry/${LIVE}`,
      "orquester-knowledge:entry/ke_%61aaaaaaaaaaa",
      `orquester-knowledge:entry/${LIVE}?x=javascript:alert(1)`,
      `orquester-knowledge:entry/${LIVE}#x`,
      `orquester-knowledge:entry/${LIVE}/../x`,
      `javascript:orquester-knowledge:entry/${LIVE}`,
      `javascript:alert(1)//orquester-knowledge:entry/${LIVE}`,
      `orquester-knowledge:entry/${LIVE}${"a".repeat(10_000)}`,
      "orquester-knowledge:entry/ke_aaaaaaaaaaa",
      "orquester-knowledge://entry/ke_aaaaaaaaaaaa"
    ];
    for (const url of refused) assert.equal(t(url), "", JSON.stringify(url.slice(0, 80)));
    // Every other scheme keeps react-markdown's own filter.
    for (const [url, expected] of [
      ["https://a.example/x", "https://a.example/x"],
      ["mailto:a@b.c", "mailto:a@b.c"],
      ["#frag", "#frag"],
      ["./rel", "./rel"],
      ["data:text/html,x", ""],
      ["vbscript:x", ""],
      ["file:///etc/passwd", ""]
    ] as const) {
      assert.equal(t(url), expected, url);
      assert.equal(t(url, "src"), expected, url);
    }
  });

  it("renders link text as text and never as HTML, and a citation-shaped image as no image", () => {
    const html = renderToStaticMarkup(
      createElement(markdown.ChatMarkdown, {
        text: `[<img src=x onerror=alert(1)>](orquester-knowledge:entry/${LIVE}) ![pic](orquester-knowledge:entry/${LIVE})`
      })
    );
    assert.doesNotMatch(html, /<img[^>]*onerror/);
    assert.doesNotMatch(html, /src="orquester-knowledge:/);
    assert.doesNotMatch(html, /href="orquester-knowledge:/);
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
    assert.equal(chips(LIVE).length, 2);
    assert.equal(doc().querySelectorAll('a[href^="orquester-knowledge:"]').length, 0, "no anchor carries the scheme");
    assert.ok(doc().querySelector('a[href="https://example.com/docs"]'), "other links are unchanged");
    assert.deepEqual(reads, [], "nothing is read on render");
  });

  it("a click opens the entry in the Knowledge view and does not navigate", async () => {
    await show(true);
    const event = await fire(chips(LIVE)[0]!, "click");
    assert.equal(event.defaultPrevented, true);
    assert.equal(dom.window.location.href, "http://localhost/");
    const { open, focus } = useAppStore.getState().knowledgeView;
    assert.equal(open, true);
    assert.equal(focus?.kind, "entry");
    assert.equal(focus?.id, LIVE);
  });

  it("middle-, ctrl-, meta- and keyboard activation never open a window or navigate", async () => {
    await show(true);
    const opened: unknown[] = [];
    const original = dom.window.open;
    dom.window.open = ((...args: unknown[]) => (opened.push(args), null)) as typeof dom.window.open;
    try {
      const chip = chips(LIVE)[0]!;
      assert.equal(chip.getAttribute("href"), null);
      assert.notEqual(chip.getAttribute("draggable"), "true");
      for (const init of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
        await act(async () => {
          chip.dispatchEvent(new dom.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, ...init }));
          chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
        });
      }
      await act(async () => {
        chip.focus();
        chip.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      await settle();
      assert.deepEqual(opened, []);
      assert.equal(dom.window.location.href, "http://localhost/");
    } finally {
      dom.window.open = original;
    }
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

describe("a knowledge citation's hover card", () => {
  let root: Root;
  let reads: string[];
  let initial: ReturnType<typeof useAppStore.getState>;

  const api = {
    connection: { id: "c1" },
    getKnowledgeItem: async (id: string) => {
      reads.push(id);
      if (id === GONE) throw new ApiError(404, "GET", `/api/knowledge/items/${id}`, {}, { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." });
      return {
        kind: "entry",
        entry: {
          entry: entry({ id, collections: ["kc_seo", "kc_ads"], body: "## Why\n\nMake a page for **every** competitor.\n\nSecond paragraph." }),
          concepts: [],
          related: [],
          citation: ""
        }
      };
    },
    deleteKnowledgeEntry: async () => ({}),
    listKnowledgeCollections: async () => collections()
  };

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    reads = [];
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

  const show = async (on = true) => {
    useAppStore.setState({ api: api as never, plugins: [knowledgePlugin(on)], currentProject: PROJECT as never });
    knowledgeStore.setState({ collections: collections([collection(), collection({ id: "kc_ads", name: "Ads", color: "chart-2" })]) });
    const text = `See [Alternatives pages · @hridoyreh](orquester-knowledge:entry/${LIVE}) and [Old note](orquester-knowledge:entry/${GONE}).`;
    await act(async () => root.render(createElement(markdown.ChatMarkdown, { text })));
    await settle();
  };

  const doc = () => dom.window.document;
  const chip = (id: string) => doc().querySelector<HTMLButtonElement>(`button[data-knowledge-citation="${id}"]`)!;
  const card = (id: string) => doc().querySelector<HTMLElement>(`[data-knowledge-citation-card="${id}"]`);
  const focus = async (element: HTMLElement) => {
    await act(async () => element.focus());
    await settle();
  };
  const blur = async (element: HTMLElement) => {
    await act(async () => element.blur());
    await settle();
  };
  const key = async (name: string) => {
    await act(async () => {
      doc().activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    });
    await settle();
  };

  it("is not there, and reads nothing, until a chip is focused or hovered", async () => {
    await show();
    assert.equal(card(LIVE), null);
    assert.equal(doc().querySelector('[role="tooltip"]'), null);
    assert.deepEqual(reads, []);
  });

  it("shows on focus with the entry's title, byline, date, collections and opening lines; Escape hides it", async () => {
    await show();
    await focus(chip(LIVE));
    const shown = card(LIVE);
    assert.ok(shown, "focus shows the card");
    assert.equal(shown.getAttribute("role"), "tooltip");
    assert.equal(chip(LIVE).getAttribute("aria-describedby"), shown.id, "the chip is described by it");
    assert.match(shown.textContent!, /Alternatives pages/);
    assert.match(shown.textContent!, /Hridoy · @hridoyreh · Oct 11, 2026/);
    assert.match(shown.textContent!, /SEO/);
    assert.match(shown.textContent!, /Ads/);
    const snippet = shown.querySelector("[data-knowledge-citation-snippet]");
    assert.equal(snippet?.textContent, "Why Make a page for every competitor. Second paragraph.");
    assert.ok(snippet?.classList.contains("line-clamp-2"), "two lines at most");
    assert.deepEqual(reads, [LIVE], "read once, on focus");

    await key("Escape");
    assert.equal(card(LIVE), null, "Escape hides it");
    assert.equal(chip(LIVE).getAttribute("aria-describedby"), null);

    await focus(chip(GONE));
    assert.ok(card(GONE));
    await blur(chip(GONE));
    assert.equal(card(GONE), null, "leaving the chip hides it");
  });

  it("says a deleted entry is deleted", async () => {
    await show();
    await focus(chip(GONE));
    const shown = card(GONE);
    assert.ok(shown);
    assert.match(shown.textContent!, /Old note\s*deleted/);
    assert.match(shown.textContent!, /This knowledge entry was deleted\./);
    assert.equal(chip(GONE).dataset.state, "deleted");
  });

  it("keeps the answer for the next card: one read per entry", async () => {
    await show();
    await focus(chip(LIVE));
    await key("Escape");
    await blur(chip(LIVE));
    await focus(chip(LIVE));
    assert.match(card(LIVE)!.textContent!, /Make a page for every competitor/);
    assert.deepEqual(reads, [LIVE]);
  });

  it("has no card while the plugin is off", async () => {
    await show(false);
    assert.equal(doc().querySelector("button[data-knowledge-citation]"), null);
    assert.equal(doc().querySelector('[role="tooltip"]'), null);
    assert.deepEqual(reads, []);
  });
});
