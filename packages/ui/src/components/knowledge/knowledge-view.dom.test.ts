/**
 * The Knowledge tab in a DOM: the plugin's states, the graph view's node →
 * side panel, the List toggle, editing a collection and an entry, and a focus
 * request (a citation) selecting its entry. The graph canvas is a stand-in
 * that draws one button per concept.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  KnowledgeEntriesQuery,
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  KnowledgeItemResponse,
  UpdateKnowledgeCollectionRequest,
  UpdateKnowledgeEntryRequest
} from "@orquester/api";

import type { KnowledgeFocus } from "../../store/app";
import { collection, collections, entry, knowledgePlugin, node, status, summary } from "../../lib/knowledge/fixtures.test-helpers";
import type { KnowledgeGraphCanvasProps } from "./KnowledgeGraphCanvas";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use
// (a text field's `onChange` needs the `input` event).
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../store/app").useAppStore;
let knowledgeStore: typeof import("../../lib/knowledge/store").knowledgeStore;
let resetKnowledge: typeof import("../../lib/knowledge/store").resetKnowledge;
let KnowledgeView: typeof import("./KnowledgeView").KnowledgeView;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "Event"
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
  ({ useAppStore } = await import("../../store/app"));
  ({ knowledgeStore, resetKnowledge } = await import("../../lib/knowledge/store"));
  ({ KnowledgeView } = await import("./KnowledgeView"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/** The canvas stand-in: a button per concept, marking the selected one. */
const StubCanvas = ({ nodes, selectedId, onSelect }: KnowledgeGraphCanvasProps) =>
  createElement(
    "div",
    { "data-testid": "canvas" },
    nodes.map((n) =>
      createElement("button", { key: n.id, type: "button", "data-node": n.id, "data-selected": String(n.id === selectedId), onClick: () => onSelect(n.id) }, n.label)
    )
  );

const GRAPH: KnowledgeGraphResponse = {
  nodes: [
    node({ id: "tactic-alternatives", name: "Alternatives pages", degree: 1 }),
    node({ id: "tactic-vs", name: "Competitor vs you", collections: ["kc_seo", "kc_ads"], degree: 1 })
  ],
  edges: [{ id: "e1", type: "RELATED_TO", from: "tactic-alternatives", to: "tactic-vs", confidence: 0.8 }],
  truncated: false,
  totals: { nodes: 2, edges: 1 }
};

const CONCEPT: KnowledgeItemResponse = {
  kind: "concept",
  concept: {
    concept: { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", confidence: 0.86, description: "A page per competitor.", aliases: [], attributes: {} },
    collections: ["kc_seo"],
    entries: [summary()],
    neighbors: [{ edge: GRAPH.edges[0]!, concept: { id: "tactic-vs", name: "Competitor vs you", type: "Tactic" } }]
  }
};

const ENTRY: KnowledgeItemResponse = {
  kind: "entry",
  entry: { entry: entry(), concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }], related: [], citation: "" }
};

describe("the Knowledge tab", () => {
  let root: Root;
  let calls: string[];
  let patches: Array<[string, UpdateKnowledgeCollectionRequest | UpdateKnowledgeEntryRequest]>;
  let initial: ReturnType<typeof useAppStore.getState>;

  const api = (entries: number, overrides: Record<string, unknown> = {}) => ({
    connection: { id: "c1" },
    getKnowledgeStatus: async () => (calls.push("status"), status({ entries })),
    listKnowledgeCollections: async () => (calls.push("collections"), collections([collection({ profiles: [{ id: "p1", name: "SaaS expert" }] }), collection({ id: "kc_ads", name: "Ads", color: "chart-2", entryCount: 0 })])),
    getKnowledgeGraph: async (query: KnowledgeGraphQuery = {}) => (calls.push(`graph:${query.focus ?? ""}`), GRAPH),
    searchKnowledge: async () => ({ hits: [], searched: [] }),
    getKnowledgeItem: async (id: string) => (calls.push(`item:${id}`), id.startsWith("ke_") ? ENTRY : CONCEPT),
    listKnowledgeEntries: async (query: KnowledgeEntriesQuery = {}) => (calls.push(`entries:${query.collection ?? "all"}`), { entries: [summary()], nextCursor: null }),
    createKnowledgeCollection: async () => (calls.push("create"), {}),
    updateKnowledgeCollection: async (id: string, req: UpdateKnowledgeCollectionRequest) => (patches.push([id, req]), {}),
    deleteKnowledgeCollection: async (id: string) => (calls.push(`delete-collection:${id}`), {}),
    updateKnowledgeEntry: async (id: string, req: UpdateKnowledgeEntryRequest) => (patches.push([id, req]), {}),
    deleteKnowledgeEntry: async (id: string) => (calls.push(`delete-entry:${id}`), {}),
    ...overrides
  });

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
    patches = [];
    resetKnowledge();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetKnowledge();
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };

  const show = async (opts: { on?: boolean; entries?: number; focus?: KnowledgeFocus | null; api?: Record<string, unknown> } = {}) => {
    useAppStore.setState({ api: api(opts.entries ?? 2, opts.api) as never, plugins: [knowledgePlugin(opts.on ?? true)] });
    if (opts.on !== false) knowledgeStore.setState({ status: status({ entries: opts.entries ?? 2 }) });
    await act(async () => root.render(createElement(KnowledgeView, { focus: opts.focus ?? null, active: true, Canvas: StubCanvas })));
    await settle();
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const buttonNamed = (name: string) => {
    const found = [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
    assert.ok(found, `a button "${name}"`);
    return found as HTMLButtonElement;
  };
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };
  const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const inputLabelled = (label: string) => {
    const element = [...doc().querySelectorAll("label")].find((l) => l.textContent?.trim() === label);
    assert.ok(element, `a field "${label}"`);
    return doc().getElementById(element.htmlFor) as HTMLInputElement;
  };

  it("says the plugin is off, and offers its settings", async () => {
    await show({ on: false });
    assert.match(text(), /Knowledge Graph is off/);
    await click(buttonNamed("Open Plugins"));
    assert.equal(useAppStore.getState().settingsOpen, true);
    assert.equal(useAppStore.getState().settingsSection, "plugins");
  });

  it("says how to add the first entry when there is none", async () => {
    await show({ entries: 0 });
    assert.match(text(), /No entries yet/);
    assert.match(text(), /Paste a post into any chat and ask the agent to add it to the knowledge/);
  });

  it("a knowledge base that cannot be opened (its counts read 0) shows the error, not \"No entries yet\"", async () => {
    const refused = () => Object.assign(new Error("500"), { status: 500, body: { code: "KNOWLEDGE_ERROR", message: "The knowledge base could not be opened (EACCES). See the daemon log." } });
    await show({
      entries: 0,
      api: {
        getKnowledgeGraph: async () => {
          throw refused();
        }
      }
    });
    assert.match(text(), /The knowledge base could not be opened \(EACCES\)/);
    assert.doesNotMatch(text(), /No entries yet/);
  });

  it("says how many entries could not be linked instead of calling an idle linking complete", async () => {
    await show();
    await act(async () => knowledgeStore.setState({ status: status({ entries: 2, failedEntries: 2 }) }));
    const bar = doc().querySelector('[role="status"][aria-label="Knowledge status"]');
    assert.ok(bar, "the status bar");
    assert.match(bar.textContent ?? "", /2 entries could not be linked/);
    assert.match(bar.textContent ?? "", /Settings → Plugins → Knowledge Graph/);
    assert.doesNotMatch(bar.innerHTML, /Every entry is linked/);
  });

  it("opens on the graph; a concept opens its panel, and an entry in it opens the entry, with Back", async () => {
    await show();
    assert.ok(doc().querySelector('[data-testid="canvas"]'), "the graph view is first");
    assert.match(text(), /2 entries · 3 concepts · 2 collections/);
    assert.match(text(), /Linking idle/);

    await click(doc().querySelector('[data-node="tactic-alternatives"]')!);
    const panel = () => doc().querySelector('aside[aria-label="Concept details"], aside[aria-label="Entry details"]');
    assert.equal(panel()?.getAttribute("aria-label"), "Concept details");
    assert.match(panel()!.textContent!, /Tactic · 86% confidence/);
    assert.match(panel()!.textContent!, /A page per competitor\./);
    assert.match(panel()!.textContent!, /Make a page for every competitor/, "the entry behind it, quoted");
    assert.match(panel()!.textContent!, /Linked to.*Competitor vs you/);
    assert.equal(doc().querySelector('[data-node="tactic-alternatives"]')?.getAttribute("data-selected"), "true");
    assert.ok(panel()!.querySelector('a[href="https://x.com/hridoyreh/status/1"]'), "Open post");

    const entryTitle = [...panel()!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Alternatives pages"))!;
    await click(entryTitle);
    assert.equal(panel()?.getAttribute("aria-label"), "Entry details");
    assert.match(panel()!.textContent!, /Make a page for every competitor: \[competitor\] vs \[you\]\./, "the full body");
    await click(buttonNamed("Back"));
    assert.equal(panel()?.getAttribute("aria-label"), "Concept details");
    await click(buttonNamed("Close panel"));
    assert.equal(panel(), null);
  });

  it("toggles to the list: collections with counts and profiles, entry cards that open the entry", async () => {
    await show();
    const listRadio = [...doc().querySelectorAll('[role="radiogroup"][aria-label="View"] button')].find((b) => b.textContent === "List")!;
    await click(listRadio);
    assert.equal(doc().querySelector('[data-testid="canvas"]'), null);
    const nav = doc().querySelector('nav[aria-label="Collections"]')!;
    assert.match(nav.textContent!, /All/);
    assert.match(nav.textContent!, /SEO.*SaaS expert/);
    assert.match(nav.textContent!, /Unfiled/);
    assert.ok(calls.includes("entries:all"));

    await click([...nav.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Ads"))!);
    assert.ok(calls.includes("entries:kc_ads"));

    const card = [...doc().querySelectorAll("button[aria-pressed]")].find((b) => b.textContent?.includes("Alternatives pages"))!;
    await click(card);
    assert.equal(doc().querySelector("aside")?.getAttribute("aria-label"), "Entry details");
  });

  it("edits a collection and refetches the list; a taken name is refused before sending", async () => {
    await show();
    await click([...doc().querySelectorAll('[role="radiogroup"][aria-label="View"] button')].find((b) => b.textContent === "List")!);
    await click(buttonNamed("Edit SEO"));
    assert.ok(doc().querySelector('form[aria-label="Edit collection"]'));

    await type(inputLabelled("Name"), "ads");
    await click(buttonNamed("Save"));
    assert.match(text(), /There is already a collection named “ads”/);
    assert.deepEqual(patches, []);

    await type(inputLabelled("Name"), "Search");
    await click(doc().querySelector('[role="radio"][aria-label="Colour 4"]')!);
    const before = calls.filter((c) => c === "collections").length;
    await click(buttonNamed("Save"));
    assert.deepEqual(patches, [["kc_seo", { name: "Search", color: "chart-4" }]]);
    assert.equal(doc().querySelector('form[aria-label="Edit collection"]'), null, "the dialog closed");
    assert.equal(calls.filter((c) => c === "collections").length, before + 1, "the collections were read again");
  });

  it("deleting a collection asks first and says what happens to its entries", async () => {
    await show();
    await click([...doc().querySelectorAll('[role="radiogroup"][aria-label="View"] button')].find((b) => b.textContent === "List")!);
    await click(buttonNamed("Edit SEO"));
    await click(buttonNamed("Delete"));
    assert.match(text(), /an entry with no other collection becomes Unfiled/);
    assert.ok(!calls.includes("delete-collection:kc_seo"));
    const confirm = [...doc().querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Delete").pop()!;
    await click(confirm);
    assert.ok(calls.includes("delete-collection:kc_seo"));
  });

  it("a focus request selects its entry; editing it sends only what changed", async () => {
    await show({ focus: { kind: "entry", id: "ke_aaaaaaaaaaaa", nonce: 1 } });
    const panel = doc().querySelector("aside")!;
    assert.equal(panel.getAttribute("aria-label"), "Entry details");
    assert.ok(calls.includes("item:ke_aaaaaaaaaaaa"));

    await click(buttonNamed("Edit"));
    await type(inputLabelled("Title"), "Alternatives pages, revisited");
    await click([...doc().querySelectorAll('form[aria-label="Edit entry"] button[aria-pressed]')].find((b) => b.textContent === "Ads")!);
    await click(buttonNamed("Save"));
    assert.deepEqual(patches, [["ke_aaaaaaaaaaaa", { title: "Alternatives pages, revisited", collections: ["kc_ads", "kc_seo"] }]]);
    assert.equal(doc().querySelector('form[aria-label="Edit entry"]'), null);
  });

  it("deleting an entry asks first, then closes the panel", async () => {
    await show({ focus: { kind: "entry", id: "ke_aaaaaaaaaaaa", nonce: 1 } });
    await click(buttonNamed("Delete"));
    assert.match(text(), /Delete this entry\?/);
    const confirm = [...doc().querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Delete").pop()!;
    await click(confirm);
    assert.ok(calls.includes("delete-entry:ke_aaaaaaaaaaaa"));
    assert.equal(doc().querySelector("aside"), null);
  });

  const showList = async () =>
    click([...doc().querySelectorAll('[role="radiogroup"][aria-label="View"] button')].find((b) => b.textContent === "List")!);

  it("keeps the pages loaded with Load more when entries change", async () => {
    const pages: Record<string, { entries: ReturnType<typeof summary>[]; nextCursor: string | null }> = {
      "": { entries: [summary({ id: "ke_aaaaaaaaaaaa", title: "First page entry" })], nextCursor: "p2" },
      p2: { entries: [summary({ id: "ke_bbbbbbbbbbbb", title: "Second page entry" })], nextCursor: "p3" },
      p3: { entries: [summary({ id: "ke_cccccccccccc", title: "Third page entry" })], nextCursor: null }
    };
    await show({
      api: {
        listKnowledgeEntries: async (query: KnowledgeEntriesQuery = {}) => (calls.push(`entries:${query.cursor ?? ""}`), pages[query.cursor ?? ""]!)
      }
    });
    await showList();
    await click(buttonNamed("Load more"));
    assert.match(text(), /First page entry.*Second page entry/);

    calls.length = 0;
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1, changedEntryIds: null })));
    await settle();
    assert.deepEqual(calls.filter((c) => c.startsWith("entries:")), ["entries:", "entries:p2"], "read again to the same depth");
    assert.match(text(), /First page entry.*Second page entry/);
    assert.doesNotMatch(text(), /Third page entry/);
    assert.ok(buttonNamed("Load more"), "and it can still page on");
  });

  it("keeps a search's entry hits in sight after its results close", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await show({
        api: { searchKnowledge: async () => ({ hits: [{ kind: "entry", score: 0.9, entry: summary({ title: "Competitor pages" }) }], searched: [] }) }
      });
      const input = doc().querySelector('input[aria-label="Search the knowledge"]') as HTMLInputElement;
      await type(input, "competitors");
      await act(async () => mock.timers.tick(300));
      await settle();
      assert.ok(doc().querySelector('[role="listbox"][aria-label="Search results"]'));

      await act(async () => {
        doc().body.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
      });
      assert.equal(doc().querySelector('[role="listbox"]'), null, "the results closed");
      assert.match(text(), /Matches: 1 entry\./, "the entry hit, which has no node on the canvas, is still named");
      await click(buttonNamed("Show results"));
      assert.match(doc().querySelector('[role="listbox"]')!.textContent!, /Competitor pages/);
    } finally {
      mock.timers.reset();
    }
  });

  it("a concept asked for before the graph loaded gets its neighbourhood once it does", async () => {
    await show({ focus: { kind: "concept", id: "tactic-far", nonce: 1 } });
    assert.deepEqual(calls.filter((c) => c.startsWith("graph:")), ["graph:", "graph:tactic-far"], "the overview lacks it: its neighbourhood is read");
  });

  it("a collection's edit button can take keyboard focus (it is faded, never hidden)", async () => {
    await show();
    await showList();
    const edit = buttonNamed("Edit SEO");
    assert.ok(!edit.classList.contains("invisible"), "visibility: hidden would take it out of the tab order");
    assert.ok(edit.classList.contains("focus-visible:opacity-100"), "it shows when focused");
  });

  it("when the item the canvas centred on is gone, it returns to the overview instead of an error", async () => {
    const truncated = { ...GRAPH, truncated: true, totals: { nodes: 5000, edges: 9000 } };
    await show({
      focus: { kind: "entry", id: "ke_aaaaaaaaaaaa", nonce: 1 },
      api: {
        getKnowledgeGraph: async (query: KnowledgeGraphQuery = {}) => {
          calls.push(`graph:${query.focus ?? ""}`);
          if (query.focus) throw Object.assign(new Error("404"), { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "Nothing visible has that id." } });
          return truncated;
        }
      }
    });
    assert.deepEqual(calls.filter((c) => c.startsWith("graph:")), ["graph:", "graph:ke_aaaaaaaaaaaa", "graph:"]);
    assert.doesNotMatch(text(), /Nothing visible has that id/);
    assert.match(text(), /Showing the 2 most connected of 5,000 concepts/);
  });
});
