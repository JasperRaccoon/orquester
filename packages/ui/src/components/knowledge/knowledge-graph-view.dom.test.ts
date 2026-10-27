/**
 * The Graph view in a DOM: the layer switch (offered only where the daemon serves the
 * similarity graph), the Similarity layer's nodes, legend, empty states and refetch, and the
 * search dropdown's keyboard, match badges and "Show all" line. The canvas is a stand-in that
 * draws one button per node and records the props it was given.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeSimilarityGraphQuery,
  KnowledgeSimilarityGraphResponse
} from "@orquester/api";

import { collection, node, status, summary } from "../../lib/knowledge/fixtures.test-helpers";
import type { KnowledgeQuery } from "./query-state";
import type { KnowledgeGraphCanvasProps } from "./KnowledgeGraphCanvas";
import type { KnowledgeSelection } from "./KnowledgePanel";
import type { SelectedConcept } from "./KnowledgeGraphView";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useAppStore: typeof import("../../store/app").useAppStore;
let knowledgeStore: typeof import("../../lib/knowledge/store").knowledgeStore;
let KnowledgeGraphView: typeof import("./KnowledgeGraphView").KnowledgeGraphView;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event"] as const;
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
  ({ useAppStore } = await import("../../store/app"));
  ({ knowledgeStore } = await import("../../lib/knowledge/store"));
  ({ KnowledgeGraphView } = await import("./KnowledgeGraphView"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const GRAPH: KnowledgeGraphResponse = {
  nodes: [node({ id: "tactic-a", name: "Alternatives pages" }), node({ id: "tactic-b", name: "Competitor vs you" })],
  edges: [{ id: "e1", type: "RELATED_TO", from: "tactic-a", to: "tactic-b", confidence: 0.8 }],
  truncated: false,
  totals: { nodes: 2, edges: 1 }
};

const simNode = (id: string, cluster: number, title = `Entry ${id}`) => ({
  id,
  title,
  kind: "post",
  author: null,
  handle: null,
  savedAt: "2026-10-20T10:00:00.000Z",
  collections: ["kc_seo"],
  cluster,
  degree: 1
});

const SIMILARITY: KnowledgeSimilarityGraphResponse = {
  nodes: [simNode("ke_a", 0), simNode("ke_b", 0), simNode("ke_c", 1)],
  edges: [
    { from: "ke_a", to: "ke_b", similarity: 0.9, tree: true },
    { from: "ke_b", to: "ke_c", similarity: 0.7, tree: false }
  ],
  clusters: [
    { id: 0, size: 2, label: "Paywalls" },
    { id: 1, size: 1, label: null }
  ],
  truncated: true,
  totals: { entries: 5, embedded: 4 }
};

const missingRoute = () => Object.assign(new Error("404"), { status: 404, body: { message: "Route GET:/api/knowledge/similarity-graph not found", error: "Not Found", statusCode: 404 } });

describe("the Graph view", () => {
  let root: Root;
  let canvasProps: KnowledgeGraphCanvasProps[];
  let selections: (KnowledgeSelection | null)[];
  let similarityReads: KnowledgeSimilarityGraphQuery[];
  let searches: KnowledgeSearchRequest[];
  let initial: ReturnType<typeof useAppStore.getState>;

  const StubCanvas = (props: KnowledgeGraphCanvasProps) => {
    canvasProps.push(props);
    return createElement(
      "div",
      { "data-testid": "canvas", "data-layer": props.layer ?? "concepts" },
      props.nodes.map((n) =>
        createElement(
          "button",
          { key: n.id, type: "button", "data-node": n.id, "data-hit": String(props.highlightIds.has(n.id)), onClick: () => props.onSelect(n.id) },
          n.label
        )
      )
    );
  };

  const api = (overrides: Record<string, unknown> = {}) => ({
    getKnowledgeGraph: async () => GRAPH,
    searchKnowledge: async (req: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> => (searches.push(req), { hits: [], searched: [] }),
    getKnowledgeSimilarityGraph: async (query: KnowledgeSimilarityGraphQuery = {}) => (similarityReads.push(query), SIMILARITY),
    ...overrides
  });

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    canvasProps = [];
    selections = [];
    similarityReads = [];
    searches = [];
  });

  afterEach(async () => {
    // The layer is remembered for the session: leave the next test on Concepts.
    const concepts = layerRadio("Concepts");
    if (concepts && concepts.getAttribute("aria-checked") !== "true") await click(concepts);
    act(() => root.unmount());
    useAppStore.setState(initial, true);
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };

  const show = async (
    opts: {
      api?: Record<string, unknown> | null;
      installed?: boolean;
      embeddingModelReady?: boolean;
      query?: KnowledgeQuery;
      onQueryChange?: (query: KnowledgeQuery) => void;
      onOpenInList?: () => void;
      filter?: string[];
      toolbarEnd?: ReturnType<typeof createElement>;
    } = {}
  ) => {
    const props = {
      api: (opts.api === null ? null : api(opts.api)) as never,
      status: status({ installed: opts.installed ?? true, ...(opts.embeddingModelReady !== undefined ? { embeddingModelReady: opts.embeddingModelReady } : {}) }),
      collections: [collection()],
      filter: opts.filter ?? [],
      onFilter: () => undefined,
      selection: null,
      onSelect: (s: KnowledgeSelection | null) => selections.push(s),
      entryConceptIds: [],
      onShowList: () => undefined,
      active: true,
      Canvas: StubCanvas,
      toolbarEnd: opts.toolbarEnd ?? null,
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.onQueryChange ? { onQueryChange: opts.onQueryChange } : {}),
      ...(opts.onOpenInList ? { onOpenInList: opts.onOpenInList } : {})
    };
    await act(async () => root.render(createElement(KnowledgeGraphView, props)));
    await settle();
    return props;
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const layerRadio = (label: string) =>
    ([...doc().querySelectorAll('[role="radiogroup"][aria-label="Layer"] button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined) ?? null;
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };
  const lastCanvas = () => canvasProps[canvasProps.length - 1]!;
  const input = () => doc().querySelector('input[aria-label="Search the knowledge"]') as HTMLInputElement;
  const type = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input(), value);
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  /** Press `name` in the search box; true when the handler kept the browser's own default. */
  const key = async (name: string) => {
    let kept = true;
    await act(async () => {
      kept = input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    });
    await settle();
    return kept;
  };

  it("lays the toolbar out for a phone: search, then the switches, then one sideways-scrolling row of chips", async () => {
    await show({ toolbarEnd: createElement("div", { "data-testid": "view-toggle" }, "Graph | List") });
    const classes = (element: Element | null) => new Set((element?.getAttribute("class") ?? "").split(/\s+/));
    const chips = doc().querySelector('[role="group"][aria-label="Filter by collection"]')!;
    const toolbar = chips.parentElement!;
    const chipClasses = classes(chips);

    // The chips never share a line squeezed narrower than a chip (they spilled under the toggle).
    assert.ok(chipClasses.has("md:min-w-[12rem]"), "never narrower than its widest chip");
    assert.ok(!chipClasses.has("flex-1") && !chipClasses.has("flex-wrap"), "grows and wraps only on a wide bar");
    // On a phone: their own last line, one row that scrolls sideways.
    for (const name of ["max-md:order-last", "max-md:basis-full", "max-md:flex-nowrap", "max-md:overflow-x-auto"]) assert.ok(chipClasses.has(name), name);
    assert.ok([...chips.querySelectorAll("button")].every((chip) => classes(chip).has("shrink-0") && classes(chip).has("max-md:min-h-8")), "chips keep their width and a ~32 px touch height");

    // The search takes the phone's whole first line.
    assert.ok(classes(input().parentElement).has("max-md:w-full"));
    // The layer switch never wraps its options.
    const layer = doc().querySelector('[role="radiogroup"][aria-label="Layer"]');
    assert.ok(classes(layer).has("flex-nowrap") && classes(layer).has("shrink-0"));

    // The view toggle sits in the toolbar's own flow: not among the chips, nor in a positioned layer.
    const toggle = doc().querySelector('[data-testid="view-toggle"]')!;
    assert.ok(toolbar.contains(toggle) && !chips.contains(toggle));
    for (let el = toggle.parentElement; el && el !== toolbar; el = el.parentElement) {
      assert.ok(!["absolute", "fixed"].some((name) => classes(el).has(name)), "no positioned ancestor inside the toolbar");
    }
    assert.ok(![...classes(toolbar)].some((name) => name === "absolute" || name === "fixed"));
  });

  it("does not offer the Similarity layer to a daemon without its route, or a client without it", async () => {
    await show({
      api: {
        getKnowledgeSimilarityGraph: async (query: KnowledgeSimilarityGraphQuery = {}) => {
          similarityReads.push(query);
          throw missingRoute();
        }
      }
    });
    assert.deepEqual(similarityReads, [{ limit: 1, k: 1 }], "a one-entry read asks");
    assert.equal(layerRadio("Similarity"), null);
    assert.equal(lastCanvas().layer, "concepts");

    act(() => root.unmount());
    root = createRoot(doc().body.appendChild(doc().createElement("div")));
    await show({ api: { getKnowledgeSimilarityGraph: undefined } });
    assert.equal(layerRadio("Similarity"), null);
  });

  it("shows entries by similarity: cluster colours, legend, tree and k-NN edges; a node opens its entry", async () => {
    await show();
    assert.deepEqual(similarityReads, [{ limit: 1, k: 1 }]);
    await click(layerRadio("Similarity")!);
    assert.deepEqual(similarityReads.slice(1), [{}], "the whole similarity graph, within no filter");
    const props = lastCanvas();
    assert.equal(props.layer, "similarity");
    assert.equal(props.itemNoun, "entries");
    assert.deepEqual(
      props.nodes.map((n) => [n.id, n.label, n.colors]),
      [
        ["ke_a", "Entry ke_a", ["chart-1"]],
        ["ke_b", "Entry ke_b", ["chart-1"]],
        ["ke_c", "Entry ke_c", []]
      ]
    );
    assert.deepEqual(
      props.edges.map((e) => e.variant),
      ["tree", "knn"]
    );
    const legend = doc().querySelector('ul[aria-label="Clusters"]')!;
    assert.match(legend.textContent!, /Paywalls\s*2/);
    assert.match(legend.textContent!, /In no cluster\s*1/);
    assert.match(text(), /Showing the 3 most recent of 4 entries\. 1 entry is still being embedded\./);

    await click(doc().querySelector('[data-node="ke_b"]')!);
    assert.deepEqual(selections.at(-1), { kind: "entry", id: "ke_b" });

    // A legend line marks its entries.
    await click([...legend.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Paywalls"))!);
    assert.deepEqual([...lastCanvas().highlightIds].sort(), ["ke_a", "ke_b"]);

    // Colour by collection: the legend lists collections.
    await click([...doc().querySelectorAll('[role="radiogroup"][aria-label="Colour by"] button')].find((b) => b.textContent === "Collection")!);
    assert.deepEqual(
      lastCanvas().nodes.map((n) => n.colors),
      [["chart-1"], ["chart-1"], ["chart-1"]]
    );
    assert.match(doc().querySelector('ul[aria-label="Collections"]')!.textContent!, /SEO\s*3/);
    await click([...doc().querySelectorAll('[role="radiogroup"][aria-label="Colour by"] button')].find((b) => b.textContent === "Cluster")!);
  });

  it("keeps a picked cluster on the same entries when a refetch reorders the clusters, and lets go when it is gone", async () => {
    let answer: KnowledgeSimilarityGraphResponse = {
      ...SIMILARITY,
      nodes: [simNode("ke_a", 0), simNode("ke_b", 0), simNode("ke_c", 1), simNode("ke_d", 1)],
      clusters: [
        { id: 0, size: 2, label: "Paywalls" },
        { id: 1, size: 2, label: "Pricing" }
      ]
    };
    await show({ api: { getKnowledgeSimilarityGraph: async () => answer } });
    await click(layerRadio("Similarity")!);
    const legendButton = (label: string) => [...doc().querySelectorAll('ul[aria-label="Clusters"] button')].find((b) => b.textContent?.startsWith(label))!;
    await click(legendButton("Paywalls"));
    assert.deepEqual([...lastCanvas().highlightIds].sort(), ["ke_a", "ke_b"]);

    // Pricing grew: the daemon numbers it first now.
    answer = {
      ...answer,
      nodes: [simNode("ke_a", 1), simNode("ke_b", 1), simNode("ke_c", 0), simNode("ke_d", 0), simNode("ke_e", 0)],
      clusters: [
        { id: 0, size: 3, label: "Pricing" },
        { id: 1, size: 2, label: "Paywalls" }
      ]
    };
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1 })));
    await settle();
    assert.deepEqual([...lastCanvas().highlightIds].sort(), ["ke_a", "ke_b"], "still the Paywalls entries");
    assert.equal(legendButton("Paywalls").getAttribute("aria-pressed"), "true");

    // The Paywalls cluster broke up: nothing stays marked, and its key coming back later marks nothing.
    const brokenUp = answer;
    answer = { ...answer, nodes: [simNode("ke_c", 0), simNode("ke_d", 0), simNode("ke_e", 0)], clusters: [{ id: 0, size: 3, label: "Pricing" }] };
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1 })));
    await settle();
    assert.equal(lastCanvas().highlightIds.size, 0);
    answer = brokenUp;
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1 })));
    await settle();
    assert.equal(lastCanvas().highlightIds.size, 0);
  });

  it("remembers the layer for the session and keeps one canvas for both", async () => {
    await show();
    await click(layerRadio("Similarity")!);
    act(() => root.unmount());
    root = createRoot(doc().body.appendChild(doc().createElement("div")));
    canvasProps = [];
    await show();
    assert.equal(layerRadio("Similarity")?.getAttribute("aria-checked"), "true");
    assert.equal(lastCanvas().layer, "similarity");
    const canvases = doc().querySelectorAll('[data-testid="canvas"]');
    await click(layerRadio("Concepts")!);
    assert.equal(lastCanvas().layer, "concepts");
    assert.equal(doc().querySelectorAll('[data-testid="canvas"]')[0], canvases[0], "the same canvas, not a new one");
  });

  it("reads the similarity graph again when the knowledge changes", async () => {
    await show();
    await click(layerRadio("Similarity")!);
    const before = similarityReads.length;
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1 })));
    await settle();
    assert.equal(similarityReads.length, before + 1);
  });

  it("says embeddings are being computed, or that the embedding model is still being downloaded, when nothing is embedded", async () => {
    const waiting = { ...SIMILARITY, nodes: [], edges: [], clusters: [], truncated: false, totals: { entries: 3, embedded: 0 } };
    await show({ api: { getKnowledgeSimilarityGraph: async () => waiting } });
    await click(layerRadio("Similarity")!);
    assert.match(text(), /Embeddings are being computed…/);
    assert.equal(doc().querySelector('[data-testid="canvas"]')!.closest('[aria-hidden="true"]') !== null, true, "the canvas is hidden");

    act(() => root.unmount());
    root = createRoot(doc().body.appendChild(doc().createElement("div")));
    await show({ api: { getKnowledgeSimilarityGraph: async () => waiting }, embeddingModelReady: false });
    assert.match(text(), /The embedding model is still being downloaded/);
    assert.match(text(), /Search matches the words meanwhile/);
    assert.doesNotMatch(text(), /Embeddings are being computed/);
    assert.equal(doc().querySelector(".animate-spin, .motion-safe\\:animate-spin"), null, "no spinner while the model is missing");
    const open = [...doc().querySelectorAll("button")].find((b) => b.textContent?.includes("Open Plugins"))!;
    await click(open);
    assert.equal(useAppStore.getState().settingsSection, "plugins");
  });

  it("falls back to Concepts when the remembered layer meets a daemon without it", async () => {
    await show();
    await click(layerRadio("Similarity")!);
    act(() => root.unmount());
    root = createRoot(doc().body.appendChild(doc().createElement("div")));
    // Another client (a new connection): its support is not known yet.
    await show({
      api: {
        getKnowledgeSimilarityGraph: async () => {
          throw missingRoute();
        }
      }
    });
    assert.equal(layerRadio("Similarity"), null);
    assert.equal(lastCanvas().layer, "concepts");
    assert.doesNotMatch(text(), /not found/);
  });

  describe("the search dropdown", () => {
    const hit = (id: string, title: string, match?: unknown) => ({ kind: "entry" as const, score: 1, entry: summary({ id, title, snippet: `About ${title}` }), ...(match ? { match } : {}) });
    const answer = {
      hits: [
        hit("ke_1", "Paywall tests", { band: "strong", via: ["keyword", "meaning"], terms: ["paywall"], passage: null, concepts: [] }),
        hit("ke_2", "Pricing pages", { band: "weak", via: ["concept"], terms: [], passage: null, concepts: [{ id: "c", name: "Pricing", type: "Topic" }] }),
        hit("ke_3", "Old daemon hit")
      ],
      searched: [],
      total: 31
    };

    const searchWith = async (opts: Parameters<typeof show>[0] = {}) => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await show({ ...opts, api: { searchKnowledge: async (req: KnowledgeSearchRequest) => (searches.push(req), answer), ...opts.api } });
        if (!opts.query) await type("paywall");
        await act(async () => mock.timers.tick(300));
        await settle();
      } finally {
        mock.timers.reset();
      }
    };
    const options = () => [...doc().querySelectorAll('[role="listbox"] [role="option"]')];

    it("highlights the first hit, moves with ↑/↓, and opens the highlighted one with Enter", async () => {
      await searchWith();
      assert.deepEqual(
        options().map((o) => o.getAttribute("aria-selected")),
        ["true", "false", "false"]
      );
      await key("ArrowDown");
      assert.deepEqual(
        options().map((o) => o.getAttribute("aria-selected")),
        ["false", "true", "false"]
      );
      assert.equal(input().getAttribute("aria-activedescendant"), options()[1]!.id);
      await key("ArrowUp");
      await key("ArrowUp");
      assert.equal(options()[2]!.getAttribute("aria-selected"), "true", "wraps to the last");
      await key("Enter");
      assert.deepEqual(selections.at(-1), { kind: "entry", id: "ke_3" });
      assert.equal(doc().querySelector('[role="listbox"]'), null, "the results closed");
    });

    it("shows the band, how each hit was found and the terms highlighted, as text", async () => {
      await searchWith();
      const [first, second, third] = options();
      assert.match(first!.textContent!, /Strong/);
      assert.match(first!.textContent!, /Keyword/);
      assert.match(first!.textContent!, /Meaning/);
      assert.deepEqual(
        [...first!.querySelectorAll("mark")].map((m) => m.textContent),
        ["Paywall", "Paywall"],
        "in the title and the snippet"
      );
      assert.match(second!.textContent!, /Weak.*Concept Pricing/);
      assert.equal(third!.querySelectorAll("mark").length, 0, "no match from an older daemon: no badges");
      assert.doesNotMatch(third!.textContent!, /Strong|Good|Weak/);
    });

    it("Show all N results opens the List view, and is not offered without it", async () => {
      let opened = 0;
      await searchWith({ onOpenInList: () => (opened += 1) });
      const showAll = [...doc().querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show all"))!;
      assert.equal(showAll.textContent, "Show all 31 results");
      await click(showAll);
      assert.equal(opened, 1);

      act(() => root.unmount());
      root = createRoot(doc().body.appendChild(doc().createElement("div")));
      await searchWith();
      assert.equal([...doc().querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show all")), undefined);
    });

    it("promises no count when two or more collection chips are on", async () => {
      await searchWith({ onOpenInList: () => undefined, filter: ["kc_seo", "kc_ads"] });
      assert.deepEqual(searches.at(-1)?.collections, ["kc_seo", "kc_ads"]);
      const line = doc().querySelector('[role="listbox"]')!.parentElement!.lastElementChild!;
      assert.equal(line.textContent, "Show in List (all collections)");
    });

    it("closes the list on the first Escape (keeping the words, against the browser's own clear) and clears on the second", async () => {
      const changes: KnowledgeQuery[] = [];
      const query: KnowledgeQuery = { text: "paywall", similarTo: [], unlike: [], filters: {}, sort: null };
      await searchWith({ query, onQueryChange: (q) => changes.push(q) });
      await act(async () => input().focus());
      await key("ArrowDown");
      assert.ok(doc().querySelector('[role="listbox"]'), "the list is open");
      assert.equal(await key("Escape"), false, "the browser does not clear the search field");
      assert.equal(doc().querySelector('[role="listbox"]'), null, "the list closed");
      assert.equal(changes.length, 0, "the words stay");
      await key("Escape");
      assert.equal(changes.at(-1)?.text, "");
    });

    it("edits the shared query's words and searches with its filters", async () => {
      const changes: KnowledgeQuery[] = [];
      const query: KnowledgeQuery = { text: "ads", similarTo: [], unlike: [], filters: { kinds: ["thread"] }, sort: null };
      await searchWith({ query, onQueryChange: (q) => changes.push(q) });
      assert.equal(input().value, "ads");
      assert.deepEqual(searches.at(-1), { query: "ads", limit: 12, filters: { kinds: ["thread"] } });
      await type("ads tips");
      assert.deepEqual(changes, [{ ...query, text: "ads tips" }]);
      assert.equal(input().value, "ads", "the parent owns the words");
    });

    it("marks entry hits on the Similarity layer", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await show({ api: { searchKnowledge: async () => ({ hits: [hit("ke_a", "Entry ke_a")], searched: [] }) } });
        await click(layerRadio("Similarity")!);
        await type("entry");
        await act(async () => mock.timers.tick(300));
        await settle();
      } finally {
        mock.timers.reset();
      }
      assert.equal(doc().querySelector('[data-node="ke_a"]')?.getAttribute("data-hit"), "true");
      await act(async () => {
        doc().body.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
      });
      assert.match(text(), /Matches: 1 entry \(marked\)\./);
    });
  });

  describe("cross navigation between the layers (phase 2)", () => {
    const concept = (id: string, name: string) => ({ id, name, type: "Tactic" });
    const CROSS: KnowledgeSimilarityGraphResponse = {
      ...SIMILARITY,
      edges: [
        { from: "ke_a", to: "ke_b", similarity: 0.9, tree: true, contradicts: true },
        { from: "ke_b", to: "ke_c", similarity: 0.7, tree: false }
      ],
      clusters: [
        { id: 0, size: 2, label: "Paywalls", concepts: [concept("tactic-b", "Competitor vs you"), concept("tactic-far", "Hard paywall")] },
        { id: 1, size: 1, label: null }
      ]
    };

    /** The view with its selection held as the Knowledge view holds it, and the panel's read of a selected concept. */
    const showHeld = async (opts: { selection?: KnowledgeSelection | null; selectedConcept?: SelectedConcept | null; api?: Record<string, unknown> } = {}) => {
      const graphReads: string[] = [];
      const client = api({
        getKnowledgeGraph: async (query: KnowledgeGraphQuery = {}) => (graphReads.push(query.focus ?? ""), GRAPH),
        getKnowledgeSimilarityGraph: async (query: KnowledgeSimilarityGraphQuery = {}) => (similarityReads.push(query), CROSS),
        ...opts.api
      });
      const Host = () => {
        const [selection, setSelection] = useState<KnowledgeSelection | null>(opts.selection ?? null);
        return createElement(KnowledgeGraphView, {
          api: client as never,
          status: status(),
          collections: [collection()],
          filter: [],
          onFilter: () => undefined,
          selection,
          onSelect: (s: KnowledgeSelection | null) => {
            selections.push(s);
            setSelection(s);
          },
          entryConceptIds: [],
          onShowList: () => undefined,
          active: true,
          Canvas: StubCanvas,
          toolbarEnd: null,
          selectedConcept: opts.selectedConcept ?? null
        });
      };
      await act(async () => root.render(createElement(Host)));
      await settle();
      return graphReads;
    };

    it("a cluster's top concept opens in the Concepts layer: selected, and its neighbourhood read when it is not shown", async () => {
      const graphReads = await showHeld();
      await click(layerRadio("Similarity")!);
      const top = doc().querySelector('[role="group"][aria-label="Top concepts of Paywalls"]');
      assert.ok(top, "the cluster's line lists its concepts");
      assert.deepEqual(
        [...top.querySelectorAll("button")].map((b) => b.textContent),
        ["Competitor vs you", "Hard paywall"]
      );

      // On the overview already: selected where it is.
      await click(top.querySelector('[data-cluster-concept="tactic-b"]')!);
      assert.equal(layerRadio("Concepts")?.getAttribute("aria-checked"), "true");
      assert.equal(lastCanvas().layer, "concepts");
      assert.equal(lastCanvas().selectedId, "tactic-b");
      assert.deepEqual(selections.at(-1), { kind: "concept", id: "tactic-b" });
      assert.deepEqual(graphReads, [""]);

      // Not on the canvas: its neighbourhood.
      await click(layerRadio("Similarity")!);
      await click(doc().querySelector('[data-cluster-concept="tactic-far"]')!);
      assert.deepEqual(selections.at(-1), { kind: "concept", id: "tactic-far" });
      assert.deepEqual(graphReads, ["", "tactic-far"]);
      assert.equal(lastCanvas().layer, "concepts");
    });

    it("an older daemon's clusters offer no concepts", async () => {
      await showHeld({ api: { getKnowledgeSimilarityGraph: async () => SIMILARITY } });
      await click(layerRadio("Similarity")!);
      assert.equal(doc().querySelector('[role="group"][aria-label^="Top concepts of"]'), null);
    });

    it("a selected concept shows its entries in Similarity: those drawn are marked, until cleared", async () => {
      const selectedConcept: SelectedConcept = { id: "tactic-a", name: "Alternatives pages", entryIds: ["ke_a", "ke_c", "ke_not_embedded"] };
      await showHeld({ selection: { kind: "concept", id: "tactic-a" }, selectedConcept });
      const offer = [...doc().querySelectorAll("button")].find((b) => b.textContent === "Show its entries in Similarity");
      assert.ok(offer, "offered on the Concepts layer");
      await click(offer);
      assert.equal(layerRadio("Similarity")?.getAttribute("aria-checked"), "true");
      assert.equal(lastCanvas().layer, "similarity");
      assert.deepEqual([...lastCanvas().highlightIds].sort(), ["ke_a", "ke_c"], "the concept's entries ∩ the drawn nodes");
      assert.match(text(), /Marked 2 of the 3 entries behind “Alternatives pages” \(the rest are not drawn\)\./);

      await click([...doc().querySelectorAll("button")].find((b) => b.textContent === "Clear")!);
      assert.equal(lastCanvas().highlightIds.size, 0);

      // Marked again, then let go when the user switches layers.
      await click(layerRadio("Concepts")!);
      await click([...doc().querySelectorAll("button")].find((b) => b.textContent === "Show its entries in Similarity")!);
      assert.equal(lastCanvas().highlightIds.size, 2);
      await click(layerRadio("Concepts")!);
      await click(layerRadio("Similarity")!);
      assert.equal(lastCanvas().highlightIds.size, 0);
    });

    it("is not offered before the panel has read the concept, for another one, or without the Similarity layer", async () => {
      await showHeld({ selection: { kind: "concept", id: "tactic-a" }, selectedConcept: null });
      const offered = () => [...doc().querySelectorAll("button")].some((b) => b.textContent === "Show its entries in Similarity");
      assert.equal(offered(), false);

      act(() => root.unmount());
      root = createRoot(doc().body.appendChild(doc().createElement("div")));
      await showHeld({ selection: { kind: "concept", id: "tactic-a" }, selectedConcept: { id: "tactic-b", name: "B", entryIds: ["ke_a"] } });
      assert.equal(offered(), false);

      act(() => root.unmount());
      root = createRoot(doc().body.appendChild(doc().createElement("div")));
      await showHeld({
        selection: { kind: "concept", id: "tactic-a" },
        selectedConcept: { id: "tactic-a", name: "A", entryIds: ["ke_a"] },
        api: {
          getKnowledgeSimilarityGraph: async () => {
            throw missingRoute();
          }
        }
      });
      assert.equal(offered(), false);
    });

    it("hands the canvas the edges of entries that disagree, and counts them in the legend", async () => {
      await showHeld();
      await click(layerRadio("Similarity")!);
      assert.deepEqual(
        lastCanvas().edges.map((e) => [e.from, e.to, e.contradicts ?? false]),
        [
          ["ke_a", "ke_b", true],
          ["ke_b", "ke_c", false]
        ]
      );
      assert.match(doc().querySelector("[data-legend-contradictions]")?.textContent ?? "", /1 pair disagrees/);
    });
  });
});
