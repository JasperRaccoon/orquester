/**
 * The Knowledge view's List view in a DOM (retrieval spec, "List view (U1)"): searching as you
 * type, explained and paged hits, the keyboard, filter chips with facet counts, "More like this"
 * examples and "Less like this", and the Rediscover strip. The list is mounted with its query held
 * by a small harness, as KnowledgeView holds it.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  KnowledgeEntriesQuery,
  KnowledgeEntriesResponse,
  KnowledgeFacetsRequest,
  KnowledgeFacetsResponse,
  KnowledgeItemResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse
} from "@orquester/api";

import { collections, entry, summary } from "../../lib/knowledge/fixtures.test-helpers";
import type { KnowledgeQuery } from "./query-state";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let resetKnowledge: typeof import("../../lib/knowledge/store").resetKnowledge;
let knowledgeStore: typeof import("../../lib/knowledge/store").knowledgeStore;
let KnowledgeListView: typeof import("./KnowledgeListView").KnowledgeListView;
let EMPTY: KnowledgeQuery;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ resetKnowledge, knowledgeStore } = await import("../../lib/knowledge/store"));
  ({ KnowledgeListView } = await import("./KnowledgeListView"));
  ({ EMPTY_KNOWLEDGE_QUERY: EMPTY } = await import("./query-state"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const DAY = 86_400_000;

const MATCH = {
  band: "strong" as const,
  via: ["keyword" as const, "meaning" as const],
  terms: ["competitor"],
  passage: { start: 100, end: 400, chunk: 2, chunks: 12 },
  concepts: []
};

const hit = (id: string, title: string, match: typeof MATCH | undefined = MATCH) => ({
  kind: "entry" as const,
  score: 0.9,
  entry: summary({ id, title, snippet: `${title}: one competitor page each` }),
  ...(match ? { match } : {})
});

describe("the List view", () => {
  let root: Root;
  let searches: KnowledgeSearchRequest[];
  let lists: KnowledgeEntriesQuery[];
  let facetCalls: KnowledgeFacetsRequest[];
  let selected: string[];
  let current: KnowledgeQuery;
  /** The harness' query setter and whether the list is mounted (as KnowledgeView switches views). */
  let setOutside: (query: KnowledgeQuery) => void;
  let setListShown: (shown: boolean) => void;

  const fakeApi = (overrides: Record<string, unknown> = {}) => ({
    listKnowledgeEntries: async (query: KnowledgeEntriesQuery = {}): Promise<KnowledgeEntriesResponse> => (
      // Saved long ago: Rediscover stays out of these tests' searches.
      lists.push(query), { entries: [summary({ id: "ke_listed00000", title: "Listed entry", savedAt: "2026-01-02T10:00:00.000Z" })], nextCursor: null }
    ),
    searchKnowledge: async (req: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> => (searches.push(req), { hits: [], searched: [], total: 0, nextCursor: null }),
    getKnowledgeFacets: async (req: KnowledgeFacetsRequest): Promise<KnowledgeFacetsResponse> => (
      facetCalls.push(req),
      {
        facets: {
          kinds: [
            { value: "thread", label: "thread", count: 4 },
            { value: "post", label: "post", count: 2 }
          ],
          authors: [{ value: "om_patel5", label: "Om Patel (@om_patel5)", count: 3 }],
          collections: [],
          years: [{ value: "2026", label: "2026", count: 6 }]
        },
        total: 6
      }
    ),
    getKnowledgeItem: async (id: string): Promise<KnowledgeItemResponse> => ({
      kind: "entry",
      entry: { entry: entry({ id, title: `Title of ${id}` }), concepts: [], related: [], citation: "" }
    }),
    ...overrides
  });

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    searches = [];
    lists = [];
    facetCalls = [];
    selected = [];
    resetKnowledge();
  });

  afterEach(() => {
    act(() => root.unmount());
    resetKnowledge();
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };

  const show = async (api: Record<string, unknown> = {}, initial: Partial<KnowledgeQuery> = {}) => {
    const Harness = () => {
      const [query, setQuery] = useState<KnowledgeQuery>({ ...EMPTY, ...initial });
      const [shown, setShown] = useState(true);
      current = query;
      setOutside = setQuery;
      setListShown = setShown;
      if (!shown) return null;
      return createElement(KnowledgeListView, {
        api: fakeApi(api) as never,
        collections: collections(),
        collection: "all",
        onCollection: () => undefined,
        query,
        onQueryChange: setQuery,
        selection: null,
        onSelect: (s) => void selected.push(s.id),
        onNewCollection: () => undefined,
        onEditCollection: () => undefined,
        toolbarEnd: null
      });
    };
    await act(async () => root.render(createElement(Harness)));
    await settle();
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const input = () => doc().querySelector('input[aria-label="Search entries"]') as HTMLInputElement;
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
  const key = async (target: Element, keyName: string) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const type = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input(), value);
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const tick = async (ms: number) => {
    await act(async () => mock.timers.tick(ms));
    await settle();
  };

  it("searches 250 ms after typing, explains each hit, and pages with the cursor", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await show({
        searchKnowledge: async (req: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> => {
          searches.push(req);
          return req.cursor
            ? { hits: [hit("ke_bbbbbbbbbbbb", "Second page")], searched: [], total: 31, nextCursor: null }
            : { hits: [hit("ke_aaaaaaaaaaaa", "Competitor pages")], searched: [], total: 31, nextCursor: "p2" };
        }
      });
      assert.equal(lists.length, 1, "the plain list first");
      await type("competitor");
      await tick(200);
      assert.equal(searches.length, 0, "not before 250 ms");
      await tick(50);
      assert.deepEqual(searches, [{ limit: 25, query: "competitor", sort: "relevance" }]);

      assert.match(text(), /31 results/);
      const results = doc().querySelector('ul[aria-label="Search results"]')!;
      assert.deepEqual([...results.querySelectorAll("mark")].map((m) => m.textContent), ["Competitor", "Competitor", "competitor"], "title and snippet terms");
      assert.match(results.textContent!, /Strong match/);
      assert.match(results.textContent!, /Keyword.*Meaning/);
      assert.match(results.textContent!, /passage 3 of 12/);
      assert.match(results.textContent!, /SEO/, "its collections");
      assert.match(results.textContent!, /2 links/, "its link state");

      await click(buttonNamed("Load more"));
      assert.equal(searches[1]?.cursor, "p2");
      assert.match(text(), /Competitor pages.*Second page/);
      assert.ok(![...doc().querySelectorAll("button")].some((b) => b.textContent?.trim() === "Load more"), "the last page");

      const sort = doc().querySelector('[role="radiogroup"][aria-label="Sort"]')!;
      await click([...sort.querySelectorAll("button")].find((b) => b.textContent === "Newest")!);
      assert.equal(searches[searches.length - 1]?.sort, "newest");
      assert.equal(searches[searches.length - 1]?.cursor, undefined, "a new sort starts over");
    } finally {
      mock.timers.reset();
    }
  });

  it("keeps words typed just before leaving the view", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await show();
      await type("seo");
      await tick(100);
      // Off to the Graph view within the wait: the words reach the query anyway.
      await act(async () => setListShown(false));
      await settle();
      assert.equal(current.text, "seo");
      await act(async () => setListShown(true));
      await settle();
      assert.equal(input().value, "seo");
    } finally {
      mock.timers.reset();
    }
  });

  it("never mixes words typed just before \"More like this\" into its example query", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await show();
      await type("tips");
      await tick(100);
      // "More like this" from the panel within the wait: an example query, without the words.
      await act(async () => setOutside({ ...EMPTY, similarTo: ["ke_seed0000000"] }));
      await settle();
      await tick(300);
      assert.deepEqual(current.similarTo, ["ke_seed0000000"]);
      assert.equal(current.text, "", "the pending words did not join the example query");
      assert.equal(input().value, "", "the box follows the new query");
      assert.ok(searches.every((req) => !(req.similarTo && req.query)), "no search mixed them");
    } finally {
      mock.timers.reset();
    }
  });

  it("never loses a page loaded around a background refresh", async () => {
    const page = (cursor: string | undefined): KnowledgeEntriesResponse =>
      cursor === "p2"
        ? { entries: [summary({ id: "ke_second00000", title: "Second page entry", savedAt: "2026-01-01T10:00:00.000Z" })], nextCursor: "p3" }
        : { entries: [summary({ id: "ke_listed00000", title: "First page entry", savedAt: "2026-01-02T10:00:00.000Z" })], nextCursor: "p2" };
    let hold: Array<() => void> | null = null;
    await show({
      listKnowledgeEntries: (query: KnowledgeEntriesQuery = {}) => {
        lists.push(query);
        const held = hold;
        return held ? new Promise<KnowledgeEntriesResponse>((resolve) => held.push(() => resolve(page(query.cursor)))) : Promise.resolve(page(query.cursor));
      }
    });
    const loadMore = () => buttonNamed("Load more");
    const refresh = async () => {
      await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1, changedEntryIds: null })));
      await settle();
    };

    // A refresh in flight: Load more waits for it (its answer replaces the list).
    hold = [];
    await refresh();
    assert.equal(loadMore().disabled, true);
    await click(loadMore());
    assert.deepEqual(lists.map((q) => q.cursor), [undefined, undefined], "no page read meanwhile");
    hold.shift()!();
    await settle();
    assert.equal(loadMore().disabled, false);

    // Load more, then a refresh before its page arrives: the refresh reads that page too.
    await click(loadMore());
    const pending = hold.shift()!;
    await refresh();
    pending();
    while (hold.length > 0) {
      hold.shift()!();
      await settle();
    }
    assert.deepEqual(lists.map((q) => q.cursor), [undefined, undefined, "p2", undefined, "p2"]);
    assert.match(text(), /First page entry.*Second page entry/);
  });

  it("moves between results with ↑/↓, opens with the card, and Esc clears the box", async () => {
    await show(
      {
        searchKnowledge: async (req: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> => (
          searches.push(req), { hits: [hit("ke_aaaaaaaaaaaa", "First"), hit("ke_bbbbbbbbbbbb", "Second")], searched: [], total: 2, nextCursor: null }
        )
      },
      { text: "pages" }
    );
    const cards = () => [...doc().querySelectorAll("[data-knowledge-result]")];
    assert.equal(cards().length, 2);
    assert.equal(input().value, "pages");

    await key(input(), "ArrowDown");
    assert.equal(doc().activeElement, cards()[0]);
    await key(cards()[0]!, "ArrowDown");
    assert.equal(doc().activeElement, cards()[1]);
    await key(cards()[1]!, "ArrowDown");
    assert.equal(doc().activeElement, cards()[1], "stays on the last");
    await key(cards()[1]!, "ArrowUp");
    await key(cards()[0]!, "ArrowUp");
    assert.equal(doc().activeElement, input(), "back to the box");

    await click(cards()[1]!);
    assert.deepEqual(selected, ["ke_bbbbbbbbbbbb"]);

    const before = lists.length;
    await key(input(), "Escape");
    assert.equal(input().value, "");
    assert.equal(current.text, "");
    assert.ok(lists.length > before, "the plain list is shown again");
    assert.ok(doc().querySelector('ul[aria-label="Entries"]'));
  });

  it("filters by facet values with counts, scoped to the other filters, and narrows the list", async () => {
    await show();
    await click(buttonNamed("Kind"));
    const popover = () => doc().querySelector('[role="dialog"][aria-label="Filter by kind"]');
    assert.ok(popover());
    assert.deepEqual(facetCalls, [{}]);
    assert.match(popover()!.textContent!, /thread\s*4/);
    assert.match(popover()!.textContent!, /post\s*2/);

    await click([...popover()!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("thread"))!);
    assert.deepEqual(current.filters, { kinds: ["thread"] });
    assert.equal(lists[lists.length - 1]?.kinds, "thread", "the entries list is filtered");
    assert.ok(buttonNamed("Kind: thread"));
    assert.ok(popover(), "a multi-select stays open");

    await click(buttonNamed("Author"));
    assert.deepEqual(facetCalls[facetCalls.length - 1], { filters: { kinds: ["thread"] } }, "the author counts follow the kind filter");
    const authors = doc().querySelector('[role="dialog"][aria-label="Filter by author"]')!;
    assert.match(authors.textContent!, /Om Patel \(@om_patel5\)\s*3/);

    // Sorting is newest-first only, until searching.
    const sort = doc().querySelector('[role="radiogroup"][aria-label="Sort"]')!;
    assert.deepEqual([...sort.querySelectorAll("button")].map((b) => b.textContent), ["Newest"]);

    await click(buttonNamed("Clear"));
    assert.deepEqual(current, EMPTY);
    assert.equal(lists[lists.length - 1]?.kinds, undefined);
  });

  it("an older daemon without facets says filters need a newer server", async () => {
    await show({
      getKnowledgeFacets: async () => {
        throw Object.assign(new Error("404"), { status: 404, body: { error: "Not found" } });
      }
    });
    await click(buttonNamed("Year"));
    assert.match(doc().querySelector('[role="dialog"][aria-label="Filter by year"]')!.textContent!, /Filters need a newer Orquester server/);
  });

  it("shows a \"More like this\" query's examples, adds \"Less like this\", and removes examples", async () => {
    await show(
      {
        searchKnowledge: async (req: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> => (
          searches.push(req), { hits: [hit("ke_bbbbbbbbbbbb", "Hit B", undefined)], searched: [], total: 1, nextCursor: null }
        )
      },
      { similarTo: ["ke_seed0000000"] }
    );
    assert.deepEqual(searches[0], { limit: 25, similarTo: ["ke_seed0000000"], sort: "relevance" });
    const examples = () => doc().querySelector('[role="group"][aria-label="More like this"]')?.textContent ?? "";
    assert.match(examples(), /Like: Title of ke_seed0000000/, "the example's title, read lazily");
    assert.match(text(), /1 result/);

    await click(buttonNamed("Less like “Hit B”"));
    assert.deepEqual(current.unlike, ["ke_bbbbbbbbbbbb"]);
    assert.deepEqual(searches[searches.length - 1]?.unlike, ["ke_bbbbbbbbbbbb"]);
    assert.match(examples(), /Not like: Hit B/, "titled from the card it came from");

    await click(buttonNamed("Remove “Like: Title of ke_seed0000000”"));
    assert.deepEqual(current.similarTo, []);
    assert.deepEqual(current.unlike, [], "no \"not like\" without a \"like\"");
    assert.ok(doc().querySelector('ul[aria-label="Entries"]'), "back to the plain list");
  });

  it("Rediscover: older entries like this week's, hidden for an older daemon, dismissible", async () => {
    const recent = new Date(Date.now() - DAY).toISOString();
    const listing = {
      listKnowledgeEntries: async (query: KnowledgeEntriesQuery = {}): Promise<KnowledgeEntriesResponse> => (
        lists.push(query), { entries: [summary({ id: "ke_recent00000", title: "Fresh post", savedAt: recent })], nextCursor: null }
      )
    };
    const old = { kind: "entry" as const, score: 0.8, entry: summary({ id: "ke_old0000000", title: "A post from spring", savedAt: "2026-03-01T10:00:00.000Z" }) };

    // An older daemon answers without a total: nothing shows.
    await show({ ...listing, searchKnowledge: async (req: KnowledgeSearchRequest) => (searches.push(req), { hits: [old], searched: [] }) });
    assert.deepEqual(searches[0]?.similarTo, ["ke_recent00000"]);
    assert.match(searches[0]?.filters?.savedBefore ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(doc().querySelector('section[aria-label="Rediscover"]'), null);
    act(() => root.unmount());

    const mount = doc().createElement("div");
    doc().body.replaceChildren(mount);
    root = createRoot(mount);
    await show({ ...listing, searchKnowledge: async (req: KnowledgeSearchRequest) => (searches.push(req), { hits: [old], searched: [], total: 1, nextCursor: null }) });
    const strip = () => doc().querySelector('section[aria-label="Rediscover"]');
    assert.match(strip()?.textContent ?? "", /A post from spring/);
    await click([...strip()!.querySelectorAll("button")].find((b) => b.textContent?.includes("A post from spring"))!);
    assert.deepEqual(selected, ["ke_old0000000"]);

    await click(buttonNamed("Dismiss Rediscover"));
    assert.equal(strip(), null);
  });
});
