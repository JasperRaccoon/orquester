/**
 * The Knowledge view in a DOM: the plugin's states, the graph view's node →
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
  KnowledgeEntryDetail,
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  KnowledgeInsightsQuery,
  KnowledgeInsightsResponse,
  KnowledgeItemResponse,
  KnowledgeMergeRequest,
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

/** The concept answer for `id` (as the daemon answers it: under the id asked for). */
const conceptItem = (id: string): KnowledgeItemResponse =>
  CONCEPT.kind === "concept" && id !== CONCEPT.concept.concept.id ? { kind: "concept", concept: { ...CONCEPT.concept, concept: { ...CONCEPT.concept.concept, id } } } : CONCEPT;

const ENTRY: KnowledgeItemResponse = {
  kind: "entry",
  entry: { entry: entry(), concepts: [{ id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic" }], related: [], citation: "" }
};

describe("the Knowledge view", () => {
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
    getKnowledgeItem: async (id: string) => (calls.push(`item:${id}`), id.startsWith("ke_") ? ENTRY : conceptItem(id)),
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

  it("deleting the collection the list is filtered to falls back to All before anything refetches", async () => {
    let deleted = false;
    // The collections read after the delete is slow, as over a network: whatever the view
    // refetches before it lands must not name the deleted collection.
    let release: (() => void) | null = null;
    const unknown = () =>
      Object.assign(new Error("404"), { status: 404, body: { code: "KNOWLEDGE_UNKNOWN_COLLECTION", message: "No collection kc_seo." } });
    await show({
      api: {
        listKnowledgeCollections: async () => {
          calls.push("collections");
          if (!deleted) return collections([collection(), collection({ id: "kc_ads", name: "Ads", color: "chart-2", entryCount: 0 })]);
          await new Promise<void>((resolve) => (release = resolve));
          return collections([collection({ id: "kc_ads", name: "Ads", color: "chart-2", entryCount: 0 })]);
        },
        listKnowledgeEntries: async (query: KnowledgeEntriesQuery = {}) => {
          calls.push(`entries:${query.collection ?? "all"}`);
          if (deleted && query.collection === "kc_seo") throw unknown();
          return { entries: [summary()], nextCursor: null };
        },
        deleteKnowledgeCollection: async (id: string) => {
          calls.push(`delete-collection:${id}`);
          deleted = true;
          return {};
        }
      }
    });
    await click([...doc().querySelectorAll('[role="radiogroup"][aria-label="View"] button')].find((b) => b.textContent === "List")!);
    const nav = () => doc().querySelector('nav[aria-label="Collections"]')!;
    await click([...nav().querySelectorAll("button")].find((b) => b.textContent?.startsWith("SEO"))!);
    assert.ok(calls.includes("entries:kc_seo"));

    await click(buttonNamed("Edit SEO"));
    await click(buttonNamed("Delete"));
    await click([...doc().querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Delete").pop()!);
    assert.ok(release, "the collections are being read again");
    assert.doesNotMatch(text(), /no longer exists|No collection kc_seo/, "no error while the collections reload");
    await act(async () => release!());
    await settle();
    const after = calls.slice(calls.indexOf("delete-collection:kc_seo") + 1);
    assert.ok(!after.includes("entries:kc_seo"), `no read of the deleted collection (${after.join(", ")})`);
    assert.ok(after.includes("entries:all"), "All is read instead");
    assert.match(text(), /All entries/);
    assert.doesNotMatch(text(), /no longer exists|No collection kc_seo/);
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

  it("a concept asked for by a merged-away id becomes the kept concept it resolves to, without a Back to the old id", async () => {
    // The daemon answers a merged-away id with the concept it was merged into.
    await show({
      focus: { kind: "concept", id: "tactic-merged-away", nonce: 1 },
      api: { getKnowledgeItem: async (id: string) => (calls.push(`item:${id}`), id.startsWith("ke_") ? ENTRY : CONCEPT) }
    });
    const aside = doc().querySelector('aside[aria-label="Concept details"]');
    assert.ok(aside, "the panel shows the kept concept");
    assert.equal(doc().querySelector('[data-node="tactic-alternatives"]')?.getAttribute("data-selected"), "true", "the canvas selects the kept concept");
    assert.ok(calls.includes("item:tactic-alternatives"), "the selection moved to the kept id");
    assert.equal([...doc().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Back"), undefined, "the old id is not a place to go back to");
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

  it("the panel's More like this opens the List view searching for entries like that one", async () => {
    const searches: unknown[] = [];
    await show({
      focus: { kind: "entry", id: "ke_aaaaaaaaaaaa", nonce: 1 },
      api: { searchKnowledge: async (req: unknown) => (searches.push(req), { hits: [], searched: [], total: 0, nextCursor: null }) }
    });
    assert.ok(doc().querySelector('[role="radiogroup"][aria-label="View"] button[aria-checked="true"]')?.textContent !== "List", "starts outside the List view");
    await click(buttonNamed("More like this"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();
    assert.equal(doc().querySelector('[role="radiogroup"][aria-label="View"] button[aria-checked="true"]')?.textContent, "List");
    assert.ok(
      searches.some((req) => (req as { similarTo?: string[] }).similarTo?.[0] === "ke_aaaaaaaaaaaa"),
      `a search for entries like it (${JSON.stringify(searches)})`
    );
  });

  const notFound = (message = "No such entry.") => Object.assign(new Error("404"), { status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message } });
  const entriesChanged = async (ids: string[]) => {
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1, changedEntryIds: ids })));
    await settle();
  };
  const entryItem = (id: string, title: string, savedAt: string, possibleDuplicates: KnowledgeEntryDetail["possibleDuplicates"] = []): KnowledgeItemResponse => ({
    kind: "entry",
    entry: { entry: entry({ id, title, savedAt }), concepts: [], related: [], similar: [], possibleDuplicates, citation: "" }
  });

  it("a More like this whose example is deleted falls back to the plain list instead of failing forever", async () => {
    const gone = new Set<string>();
    const searches: Array<{ similarTo?: string[] }> = [];
    await show({
      focus: { kind: "entry", id: "ke_aaaaaaaaaaaa", nonce: 1 },
      api: {
        getKnowledgeItem: async (id: string) => {
          calls.push(`item:${id}`);
          if (gone.has(id)) throw notFound();
          return ENTRY;
        },
        // The list holds another entry (Rediscover may search like it).
        listKnowledgeEntries: async (query: KnowledgeEntriesQuery = {}) => (
          calls.push(`entries:${query.collection ?? "all"}`), { entries: [summary({ id: "ke_dddddddddddd", title: "Another" })], nextCursor: null }
        ),
        searchKnowledge: async (req: { similarTo?: string[] }) => {
          searches.push(req);
          const missing = (req.similarTo ?? []).find((id) => gone.has(id));
          if (missing) throw notFound(`No visible entry "${missing}".`);
          return { hits: [], searched: [], total: 0, nextCursor: null };
        }
      }
    });
    await click(buttonNamed("More like this"));
    await settle();
    assert.match(text(), /Like:/);
    assert.equal(searches.at(-1)?.similarTo?.[0], "ke_aaaaaaaaaaaa");

    // Deleted elsewhere: the change names it, the search would be refused.
    gone.add("ke_aaaaaaaaaaaa");
    calls.length = 0;
    await entriesChanged(["ke_aaaaaaaaaaaa"]);
    await settle();
    assert.doesNotMatch(text(), /Like:/, "the example chip is gone");
    assert.doesNotMatch(text(), /No visible entry|It no longer exists/, "no error stays");
    assert.ok(calls.includes("entries:all"), "the plain list again");
    const before = searches.length;
    await entriesChanged(["ke_bbbbbbbbbbbb"]);
    assert.ok(
      searches.slice(before).every((req) => !req.similarTo?.includes("ke_aaaaaaaaaaaa")),
      "it does not ask for that search again"
    );
  });

  it("after a merge deletes the open entry, Back skips it; a deleted entry leaves the history", async () => {
    const OLDER = "ke_aaaaaaaaaaaa";
    const OPEN = "ke_bbbbbbbbbbbb";
    const FIRST = "ke_cccccccccccc";
    const items = new Map<string, KnowledgeItemResponse>([
      [OLDER, entryItem(OLDER, "Original", "2026-10-01T10:00:00.000Z")],
      [OPEN, entryItem(OPEN, "Copy", "2026-10-20T10:00:00.000Z", [{ entry: summary({ id: OLDER, title: "Original", savedAt: "2026-10-01T10:00:00.000Z" }), similarity: 0.97, reasons: [] }])],
      [FIRST, entryItem(FIRST, "Where I started", "2026-10-05T10:00:00.000Z")]
    ]);
    const merges: KnowledgeMergeRequest[] = [];
    const overrides = {
      getKnowledgeItem: async (id: string) => {
        const found = items.get(id);
        if (!found) throw notFound();
        return found;
      },
      mergeKnowledgeEntries: async (req: KnowledgeMergeRequest) => {
        merges.push(req);
        for (const id of req.ids) if (id !== req.keep) items.delete(id);
        return {};
      }
    };
    await show({ focus: { kind: "entry", id: FIRST, nonce: 1 }, api: overrides });
    await act(async () => root.render(createElement(KnowledgeView, { focus: { kind: "entry", id: OPEN, nonce: 2 }, active: true, Canvas: StubCanvas })));
    await settle();
    const panelTitle = () => doc().querySelector("aside")?.textContent ?? "";
    assert.match(panelTitle(), /Copy/);

    await click(buttonNamed("Merge"));
    await click([...doc().querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Merge")!);
    await settle();
    assert.deepEqual(merges, [{ ids: [OLDER, OPEN], keep: OLDER }]);
    assert.match(panelTitle(), /Original/, "the kept entry is open");

    await click(buttonNamed("Back"));
    assert.match(panelTitle(), /Where I started/, "Back skips the deleted entry");
    assert.equal([...doc().querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Back"), false);

    // Back in history, then deleted elsewhere: no Back to it.
    await act(async () => root.render(createElement(KnowledgeView, { focus: { kind: "entry", id: OLDER, nonce: 3 }, active: true, Canvas: StubCanvas })));
    await settle();
    assert.match(panelTitle(), /Original/);
    assert.ok(buttonNamed("Back"));
    items.delete(FIRST);
    await entriesChanged([FIRST]);
    await settle();
    assert.equal([...doc().querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Back"), false, "the deleted entry left the history");
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

  it("shows the automatic re-linking in the status bar while entries are left to it", async () => {
    await show();
    const bar = () => doc().querySelector('[role="status"][aria-label="Knowledge status"]')!;
    assert.equal(bar().querySelector("[data-knowledge-relink]"), null, "an older daemon says nothing");
    await act(async () => knowledgeStore.setState({ status: status({ entries: 2, relink: { pending: 89, done: 37, total: 126 } }) }));
    const relink = bar().querySelector("[data-knowledge-relink]");
    assert.equal(relink?.textContent, "Re-linking 37/126");
    assert.match(relink?.getAttribute("title") ?? "", /89 entries are still to be linked again/);
    assert.match(bar().textContent!, /Linking idle/, "beside the linking state");
    await act(async () => knowledgeStore.setState({ status: status({ entries: 2, relink: null }) }));
    assert.equal(bar().querySelector("[data-knowledge-relink]"), null, "nothing left");
  });

  it("fits the status bar on a phone while re-linking: the linking progress bar steps aside and the re-linking text truncates", async () => {
    await show();
    const bar = () => doc().querySelector('[role="status"][aria-label="Knowledge status"]')!;
    const classes = (element: Element | null) => new Set((element?.getAttribute("class") ?? "").split(/\s+/));
    const running = { state: "running" as const, runId: "r1", mode: "update" as const, step: "pass2", progress: { done: 3, total: 10 }, pendingEntries: 0 };
    await act(async () => knowledgeStore.setState({ status: status({ entries: 2, linking: running }) }));
    assert.ok(!classes(bar().querySelector('[role="progressbar"]')).has("max-md:hidden"), "shown on a phone without re-linking");

    await act(async () => knowledgeStore.setState({ status: status({ entries: 2, linking: running, relink: { pending: 89, done: 37, total: 126 } }) }));
    assert.ok(classes(bar().querySelector('[role="progressbar"]')).has("max-md:hidden"), "below md, the progress bar steps aside for the re-linking");
    assert.ok(!classes(bar().querySelector('[role="progressbar"]')).has("hidden"), "still shown on a desktop");
    const relink = bar().querySelector("[data-knowledge-relink]");
    assert.ok(classes(relink).has("min-w-0") && !classes(relink).has("shrink-0"), "the re-linking may shrink");
    const label = [...(relink?.querySelectorAll("span") ?? [])].find((s) => s.textContent === "Re-linking 37/126");
    assert.ok(label && classes(label).has("truncate") && classes(label).has("min-w-0"), "and its text truncates");
    // Every item but the icons can shrink: nothing in the bar keeps a fixed width on a phone.
    for (const child of bar().children) {
      if (child.getAttribute("role") === "progressbar") continue;
      assert.ok(!classes(child).has("shrink-0"), `${child.textContent} shrinks`);
    }
  });

  describe("the Insights view (phase 2)", () => {
    const INSIGHTS: KnowledgeInsightsResponse = {
      contradictions: [{ a: summary(), b: summary({ id: "ke_bbbbbbbbbbbb", title: "Other" }), similarity: 0.8, source: "graph", pairs: [], note: "They disagree." }],
      bridges: [],
      singleSource: [],
      gaps: [],
      totals: { contradictions: 1, bridges: 0, singleSource: 0, gaps: 0 }
    };
    const missingRoute = () => Object.assign(new Error("404"), { status: 404, body: { message: "Route GET:/api/knowledge/insights not found", error: "Not Found", statusCode: 404 } });
    const viewRadio = (label: string) =>
      ([...doc().querySelectorAll('[role="radiogroup"][aria-label="View"] button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined) ?? null;
    const insightsApi = (read: (query: KnowledgeInsightsQuery) => Promise<KnowledgeInsightsResponse>) => ({
      getKnowledgeInsights: (query: KnowledgeInsightsQuery = {}) => {
        calls.push(`insights:${JSON.stringify(query)}`);
        return read(query);
      }
    });

    it("is not offered by a client without it", async () => {
      await show();
      assert.equal(viewRadio("Insights"), null);
      assert.ok(viewRadio("Graph") && viewRadio("List"));
    });

    it("is not offered by a daemon that predates it (a one-item read asks)", async () => {
      await show({
        api: insightsApi(async () => {
          throw missingRoute();
        })
      });
      assert.deepEqual(
        calls.filter((c) => c.startsWith("insights:")),
        ['insights:{"limit":1}']
      );
      assert.equal(viewRadio("Insights"), null);
    });

    it("is offered where the daemon serves it: its items open in the side panel, narrowed by the graph's chips", async () => {
      await show({ api: insightsApi(async () => INSIGHTS) });
      const insights = viewRadio("Insights");
      assert.ok(insights, "a third view option");
      assert.ok(insights.querySelector("svg"), "with its icon (a phone shows the icons only)");
      await click(insights);
      assert.equal(doc().querySelector('[data-testid="canvas"]'), null);
      const contradictions = doc().querySelector('section[aria-label="Contradictions"]');
      assert.ok(contradictions);
      assert.match(contradictions.textContent!, /They disagree\./);
      assert.deepEqual(calls.filter((c) => c.startsWith("insights:")).slice(1), ["insights:{}"]);

      await click(contradictions.querySelector('[data-insight-entry="ke_bbbbbbbbbbbb"]')!);
      assert.equal(doc().querySelector("aside")?.getAttribute("aria-label"), "Entry details");
      assert.ok(calls.includes("item:ke_bbbbbbbbbbbb"));

      const chips = doc().querySelector('[role="group"][aria-label="Filter by collection"]')!;
      await click([...chips.querySelectorAll("button")].find((b) => b.textContent === "SEO")!);
      assert.equal(calls.filter((c) => c.startsWith("insights:")).at(-1), 'insights:{"collections":"kc_seo"}');
      // The same chips narrow the graph.
      await click(viewRadio("Graph")!);
      assert.equal([...doc().querySelectorAll('[aria-label="Filter by collection"] button')].find((b) => b.textContent === "SEO")?.getAttribute("aria-pressed"), "true");
    });

    it("falls back to the graph, and stops offering it, when the daemon no longer serves it", async () => {
      let served = true;
      await show({
        api: insightsApi(async () => {
          if (served) return INSIGHTS;
          throw missingRoute();
        })
      });
      await click(viewRadio("Insights")!);
      assert.ok(doc().querySelector('section[aria-label="Contradictions"]'));
      served = false;
      await act(async () => knowledgeStore.setState((s) => ({ graphRevision: s.graphRevision + 1 })));
      await settle();
      assert.ok(doc().querySelector('[data-testid="canvas"]'), "back on the graph");
      assert.equal(viewRadio("Insights"), null);
    });
  });
});
