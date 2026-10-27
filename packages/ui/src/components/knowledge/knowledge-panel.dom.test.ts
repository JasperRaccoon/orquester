/**
 * The entry panel in a DOM (retrieval spec, "Entry panel and citations"): the
 * body as safe Markdown or plain text, the similar entries with their reasons
 * and "More like this", the fallback to related entries from an older daemon,
 * and the possible-duplicates banner (Open, Keep both, Merge).
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { KnowledgeEntryDetail, KnowledgeItemResponse, KnowledgeMergeRequest, UpdateKnowledgeEntryRequest } from "@orquester/api";

import { collection, collections, entry, summary } from "../../lib/knowledge/fixtures.test-helpers";
import type { KnowledgeSelection } from "./KnowledgePanel";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let resetKnowledge: typeof import("../../lib/knowledge/store").resetKnowledge;
let resetPanelSession: typeof import("./panel.logic").resetPanelSession;
let KnowledgePanel: typeof import("./KnowledgePanel").KnowledgePanel;

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
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ resetKnowledge } = await import("../../lib/knowledge/store"));
  ({ resetPanelSession } = await import("./panel.logic"));
  ({ KnowledgePanel } = await import("./KnowledgePanel"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const OPEN = "ke_new000000000";
const OLDER = "ke_old000000000";
const SIMILAR = "ke_sim000000000";
const COLLECTIONS = [collection(), collection({ id: "kc_ads", name: "Ads", color: "chart-2" })];

const BODY = [
  "# Heading",
  "",
  "Some **bold** text and [a site](https://example.com) and [bad](javascript:alert(1)).",
  "",
  "<img src=x onerror=alert(1)>"
].join("\n");

function openDetail(overrides: Partial<KnowledgeEntryDetail> = {}): KnowledgeEntryDetail {
  return {
    entry: entry({ id: OPEN, title: "Copy", body: BODY, savedAt: "2026-10-20T10:00:00.000Z", collections: ["kc_ads"] }),
    concepts: [],
    related: [],
    similar: [
      {
        entry: summary({ id: SIMILAR, title: "A close one" }),
        similarity: 0.91,
        reasons: [
          { kind: "author", value: "Hridoy" },
          { kind: "meaning", similarity: 0.91 },
          { kind: "concepts", concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }, { id: "tactic-b", name: "B", type: "Tactic" }], shared: 2 }
        ]
      }
    ],
    possibleDuplicates: [
      { entry: summary({ id: OLDER, title: "Original", savedAt: "2026-10-01T10:00:00.000Z", collections: ["kc_seo"] }), similarity: 0.97, reasons: [{ kind: "meaning", similarity: 0.97 }] }
    ],
    citation: "",
    ...overrides
  };
}

describe("the entry panel", () => {
  let root: Root;
  let calls: string[];
  let selected: KnowledgeSelection[];
  let similarAsked: string[];
  let items: Map<string, KnowledgeItemResponse>;
  let failMerge: boolean;
  let renders = 0;

  const api = {
    connection: { id: "c1" },
    getKnowledgeStatus: async () => {
      throw new Error("unused");
    },
    listKnowledgeCollections: async () => collections(COLLECTIONS),
    createKnowledgeCollection: async () => ({}),
    updateKnowledgeCollection: async () => ({}),
    deleteKnowledgeCollection: async () => ({}),
    getKnowledgeItem: async (id: string) => {
      calls.push(`get:${id}`);
      const found = items.get(id);
      if (!found) throw Object.assign(new Error("404"), { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } });
      return found;
    },
    updateKnowledgeEntry: async (id: string, req: UpdateKnowledgeEntryRequest) => {
      calls.push(`patch:${id}:${JSON.stringify(req)}`);
      return {};
    },
    deleteKnowledgeEntry: async (id: string) => {
      calls.push(`delete:${id}`);
      items.delete(id);
      return {};
    },
    mergeKnowledgeEntries: async (req: KnowledgeMergeRequest) => {
      calls.push(`merge:${JSON.stringify(req)}`);
      if (failMerge) throw Object.assign(new Error("404"), { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: `No such entry: ${OLDER}.` } });
      for (const id of req.ids) if (id !== req.keep) items.delete(id);
      return {};
    }
  };

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
    selected = [];
    similarAsked = [];
    failMerge = false;
    items = new Map();
    resetKnowledge();
    resetPanelSession();
  });

  afterEach(() => {
    act(() => root.unmount());
    resetKnowledge();
    resetPanelSession();
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    });
  };

  const show = async (detail: KnowledgeEntryDetail, opts: { findSimilar?: boolean } = {}) => {
    items.set(detail.entry.id, { kind: "entry", entry: detail });
    // Holds the selection as the Knowledge view does.
    const Host = () => {
      const [selection, setSelection] = useState<KnowledgeSelection>({ kind: "entry", id: detail.entry.id });
      return createElement(KnowledgePanel, {
        api: api as never,
        selection,
        collections: COLLECTIONS,
        onSelect: (next: KnowledgeSelection) => {
          selected.push(next);
          setSelection(next);
        },
        onClose: () => undefined,
        ...(opts.findSimilar === false ? {} : { onFindSimilar: (id: string) => void similarAsked.push(id) })
      });
    };
    await act(async () => root.render(createElement(Host, { key: ++renders })));
    await settle();
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const buttons = (name: string) =>
    [...doc().querySelectorAll("button")].filter((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
  const buttonNamed = (name: string, within: ParentNode = doc()) => {
    const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
    assert.ok(found, `a button "${name}"`);
    return found as HTMLButtonElement;
  };
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };

  it("renders the body as Markdown without raw HTML or unsafe links, and as plain text on request", async () => {
    await show(openDetail());
    const body = doc().querySelector('[data-knowledge-body="markdown"]');
    assert.ok(body, "Markdown by default");
    assert.equal(body.querySelector("h1")?.textContent, "Heading");
    assert.equal(body.querySelector("strong")?.textContent, "bold");
    const link = [...body.querySelectorAll("a")].find((a) => a.textContent === "a site");
    assert.equal(link?.getAttribute("href"), "https://example.com");
    assert.equal(link?.getAttribute("target"), "_blank");
    assert.match(link?.getAttribute("rel") ?? "", /noopener/);
    assert.ok(![...body.querySelectorAll("a")].some((a) => /javascript:/i.test(a.getAttribute("href") ?? "")), "no script link");
    assert.equal(body.querySelector("img"), null, "raw HTML is not rendered");

    const toggle = buttonNamed("Plain text");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    await click(toggle);
    const plain = doc().querySelector('[data-knowledge-body="plain"]');
    assert.ok(plain);
    assert.equal(plain.textContent, BODY, "the text as saved");

    // Remembered for the session: another panel opens in plain text too.
    act(() => root.unmount());
    root = createRoot(doc().body.appendChild(doc().createElement("div")));
    await show(openDetail());
    assert.ok(doc().querySelector('[data-knowledge-body="plain"]'));
    assert.equal(buttonNamed("Plain text").getAttribute("aria-pressed"), "true");
  });

  it("cuts a long body's Markdown until asked for the rest", async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} with some words in it.`).join("\n\n");
    await show(openDetail({ entry: entry({ id: OPEN, body: long }) }));
    const more = [...doc().querySelectorAll("button")].find((b) => /^Show the rest/.test(b.textContent ?? ""));
    assert.ok(more, "a long body offers the rest");
    assert.doesNotMatch(text(), /Paragraph 2999 /);
    await click(more);
    assert.match(text(), /Paragraph 2999 with some words/);
  });

  it("lists similar entries with their reasons, opens one, and offers More like this", async () => {
    await show(openDetail());
    const section = doc().querySelector('section[aria-label="Similar entries"]');
    assert.ok(section);
    const row = section.querySelector(`[data-knowledge-similar="${SIMILAR}"]`);
    assert.ok(row);
    const chips = [...row.querySelectorAll("span.rounded-full")].map((s) => s.textContent);
    assert.deepEqual(chips, ["Meaning 91%", "Concepts: A, B", "Same author"]);
    await click(row);
    assert.deepEqual(selected, [{ kind: "entry", id: SIMILAR }]);

    await show(openDetail());
    await click(buttonNamed("More like this"));
    assert.deepEqual(similarAsked, [OPEN]);
  });

  it("hides More like this without the prop, and falls back to related entries from an older daemon", async () => {
    const { similar: _similar, possibleDuplicates: _duplicates, ...older } = openDetail({ related: [summary({ id: SIMILAR, title: "Related one" })] });
    await show(older, { findSimilar: false });
    assert.equal(buttons("More like this").length, 0);
    const section = doc().querySelector('section[aria-label="Similar entries"]');
    assert.equal(section?.getAttribute("data-fallback"), "related");
    assert.match(section?.textContent ?? "", /Related one/);
    assert.match(section?.textContent ?? "", /Shared concepts/);
    assert.equal(doc().querySelector('section[aria-label="Possible duplicates"]'), null);
  });

  it("offers a possible duplicate: Open goes there, Keep both hides it for the session", async () => {
    await show(openDetail());
    const banner = doc().querySelector('section[aria-label="Possible duplicates"]');
    assert.ok(banner);
    assert.match(banner.textContent ?? "", /Looks like the same content as Original \(97%\)/);
    await click(buttonNamed("Open", banner));
    assert.deepEqual(selected, [{ kind: "entry", id: OLDER }]);

    await show(openDetail());
    await click(buttonNamed("Keep both", doc().querySelector('section[aria-label="Possible duplicates"]')!));
    assert.equal(doc().querySelector('section[aria-label="Possible duplicates"]'), null);
    await show(openDetail());
    assert.equal(doc().querySelector('section[aria-label="Possible duplicates"]'), null, "still hidden");
  });

  it("merges into the older entry: confirm, one merge call keeping it, then open the kept one", async () => {
    items.set(OLDER, { kind: "entry", entry: openDetail({ entry: entry({ id: OLDER, title: "Original" }), possibleDuplicates: [], similar: [] }) });
    await show(openDetail());
    await click(buttonNamed("Merge", doc().querySelector('section[aria-label="Possible duplicates"]')!));
    const dialog = doc().querySelector('[role="dialog"]');
    assert.ok(dialog, "asks first");
    assert.match(dialog.textContent ?? "", /Keeps the older entry, “Original”.*deletes this one/);
    assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), [], "nothing happens before confirming");
    await click(buttonNamed("Merge", dialog));
    await settle();
    assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), [`merge:{"ids":["${OLDER}","${OPEN}"],"keep":"${OLDER}"}`]);
    assert.deepEqual(selected, [{ kind: "entry", id: OLDER }]);
    assert.doesNotMatch(text(), /This entry was deleted/);
  });

  it("says why when the daemon refuses the merge, and stays on the entry", async () => {
    failMerge = true;
    await show(openDetail());
    await click(buttonNamed("Merge", doc().querySelector('section[aria-label="Possible duplicates"]')!));
    await click(buttonNamed("Merge", doc().querySelector('[role="dialog"]')!));
    await settle();
    assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), [`merge:{"ids":["${OLDER}","${OPEN}"],"keep":"${OLDER}"}`]);
    assert.deepEqual(selected, []);
    const alert = doc().querySelector('section[aria-label="Possible duplicates"] [role="alert"]');
    assert.equal(alert?.textContent, `Nothing was merged: No such entry: ${OLDER}.`);
  });
});
