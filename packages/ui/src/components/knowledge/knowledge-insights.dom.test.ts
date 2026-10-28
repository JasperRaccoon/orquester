/**
 * The Insights view in a DOM (phase 2 spec, "Insights view"): the four sections with their
 * counts, each item opening its entry or concept, the collection chips narrowing it, a refetch on
 * `knowledge.changed`, and its loading, empty, error and older-daemon states.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { KnowledgeInsightsQuery, KnowledgeInsightsResponse } from "@orquester/api";

import { collection, summary } from "../../lib/knowledge/fixtures.test-helpers";
import type { KnowledgeSelection } from "./KnowledgePanel";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let knowledgeStore: typeof import("../../lib/knowledge/store").knowledgeStore;
let resetKnowledge: typeof import("../../lib/knowledge/store").resetKnowledge;
let KnowledgeInsightsView: typeof import("./KnowledgeInsightsView").KnowledgeInsightsView;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event"] as const;
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
  ({ knowledgeStore, resetKnowledge } = await import("../../lib/knowledge/store"));
  ({ KnowledgeInsightsView } = await import("./KnowledgeInsightsView"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const A = summary({ id: "ke_aaaaaaaaaaaa", title: "Trials should be 7 days", author: "Om", handle: "om" });
const B = summary({ id: "ke_bbbbbbbbbbbb", title: "Trials should be 30 days", author: null, handle: null });
const C = summary({ id: "ke_cccccccccccc", title: "Pricing pages" });
const D = summary({ id: "ke_dddddddddddd", title: "Trials should be 14 days" });
const ref = (id: string, name: string, type = "Tactic") => ({ id, name, type });

const INSIGHTS: KnowledgeInsightsResponse = {
  contradictions: [
    {
      a: A,
      b: B,
      similarity: 0.82,
      source: "checked",
      pairs: [{ from: ref("tactic-short-trial", "Short trial"), to: ref("tactic-long-trial", "Long trial") }],
      note: "<b>One says a week</b>, the other a month.",
      also: [D]
    }
  ],
  bridges: [{ entry: C, clusters: [{ label: "Pricing", size: 9 }, { label: null, size: 3 }], concepts: [ref("topic-anchoring", "Anchoring", "Topic")] }],
  singleSource: [{ concept: ref("rule-never-discount", "Never discount", "Rule"), entry: B, cluster: { label: "Pricing", size: 9 } }],
  gaps: [{ a: A, b: C, similarity: 0.87, queued: true }],
  totals: { contradictions: 1, bridges: 1, singleSource: 37, gaps: 1 }
};

const EMPTY: KnowledgeInsightsResponse = {
  contradictions: [],
  bridges: [],
  singleSource: [],
  gaps: [],
  totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 }
};

const missingRoute = () => Object.assign(new Error("404"), { status: 404, body: { message: "Route GET:/api/knowledge/insights not found", error: "Not Found", statusCode: 404 } });

describe("the Insights view", () => {
  let root: Root;
  let reads: KnowledgeInsightsQuery[];
  let selections: KnowledgeSelection[];
  let filters: string[][];
  let unsupported: number;
  let answer: () => Promise<KnowledgeInsightsResponse>;

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    reads = [];
    selections = [];
    filters = [];
    unsupported = 0;
    answer = async () => INSIGHTS;
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

  const api = {
    getKnowledgeInsights: (query: KnowledgeInsightsQuery = {}) => {
      reads.push(query);
      return answer();
    }
  };

  const show = async (opts: { filter?: string[]; api?: object | null } = {}) => {
    await act(async () =>
      root.render(
        createElement(KnowledgeInsightsView, {
          api: (opts.api === undefined ? api : opts.api) as never,
          collections: [collection(), collection({ id: "kc_ads", name: "Ads", color: "chart-2" })],
          filter: opts.filter ?? [],
          onFilter: (f: string[]) => void filters.push(f),
          selection: null,
          onSelect: (s: KnowledgeSelection) => void selections.push(s),
          onUnsupported: () => void (unsupported += 1),
          toolbarEnd: createElement("div", { "data-testid": "view-toggle" }, "Graph | List | Insights")
        })
      )
    );
    await settle();
  };

  const doc = () => dom.window.document;
  const text = () => doc().body.textContent ?? "";
  const section = (label: string) => {
    const found = doc().querySelector(`section[aria-label="${label}"]`);
    assert.ok(found, `a section "${label}"`);
    return found;
  };
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };

  it("shows the four sections in order, each counted from its total", async () => {
    await show();
    assert.deepEqual(reads, [{}], "every visible collection, the daemon's default size");
    const sections = [...doc().querySelectorAll("section[data-insights-section]")];
    assert.deepEqual(
      sections.map((s) => s.getAttribute("aria-label")),
      ["Contradictions", "Bridges", "Single source", "Link gaps"]
    );
    assert.deepEqual(
      sections.map((s) => s.querySelector("[data-insights-count]")?.textContent),
      ["1", "1", "1 of 37", "1"],
      "a cut list says how many there are"
    );
    const contradiction = section("Contradictions");
    assert.match(contradiction.textContent!, /Trials should be 7 days.*disagrees with.*Trials should be 30 days/);
    assert.match(contradiction.textContent!, /Checked by an agent · 82% similar/);
    assert.match(section("Bridges").textContent!, /Links 2 clusters: “Pricing” \(9 entries\), a cluster of 3 entries/);
    assert.match(section("Single source").textContent!, /Never discount.*only in.*Trials should be 30 days/);
    assert.match(section("Link gaps").textContent!, /87% similar.*Queued for re-linking/);
  });

  it("names the entries that make the same point against the same side, each opening its entry", async () => {
    await show();
    const also = section("Contradictions").querySelector("[data-insight-also]")!;
    assert.match(also.textContent!, /also:.*Trials should be 14 days/);
    await click(also.querySelector(`[data-insight-entry="${D.id}"]`)!);
    assert.deepEqual(selections, [{ kind: "entry", id: D.id }]);
  });

  it("says which side each folded entry joins, each entry once per side", async () => {
    const E = summary({ id: "ke_eeeeeeeeeeee", title: "Trials should be 3 days", author: null, handle: "trialguy" });
    answer = async () => ({ ...INSIGHTS, contradictions: [{ ...INSIGHTS.contradictions[0]!, also: [D, E], alsoJoins: { a: [D, E], b: [E] } }] });
    await show();
    const rows = [...section("Contradictions").querySelectorAll("[data-insight-also]")];
    // B has neither author nor handle: its title names its side.
    assert.deepEqual(rows.map((row) => row.querySelector("span")!.textContent), ["Also with Om, against Trials should be 30 days:", "Also with Trials should be 30 days, against Om:"]);
    assert.deepEqual(rows.map((row) => [...row.querySelectorAll("[data-insight-entry]")].map((link) => link.getAttribute("data-insight-entry"))), [[D.id, E.id], [E.id]]);
  });

  it("renders the daemon's text as text, never as HTML", async () => {
    await show();
    const contradiction = section("Contradictions");
    assert.equal(contradiction.querySelector("b"), null);
    assert.match(contradiction.textContent!, /<b>One says a week<\/b>, the other a month\./);
  });

  it("opens each item's entry or concept in the side panel", async () => {
    await show();
    await click(section("Contradictions").querySelector(`[data-insight-entry="${B.id}"]`)!);
    await click(section("Contradictions").querySelector('[data-insight-concept="tactic-long-trial"]')!);
    await click(section("Bridges").querySelector(`[data-insight-entry="${C.id}"]`)!);
    await click(section("Bridges").querySelector('[data-insight-concept="topic-anchoring"]')!);
    await click(section("Single source").querySelector('[data-insight-concept="rule-never-discount"]')!);
    await click(section("Link gaps").querySelector(`[data-insight-entry="${A.id}"]`)!);
    assert.deepEqual(selections, [
      { kind: "entry", id: B.id },
      { kind: "concept", id: "tactic-long-trial" },
      { kind: "entry", id: C.id },
      { kind: "concept", id: "topic-anchoring" },
      { kind: "concept", id: "rule-never-discount" },
      { kind: "entry", id: A.id }
    ]);
  });

  it("narrows by the collection chips, and reads again for them", async () => {
    await show();
    const chips = doc().querySelector('[role="group"][aria-label="Filter by collection"]')!;
    await click([...chips.querySelectorAll("button")].find((b) => b.textContent === "Ads")!);
    assert.deepEqual(filters, [["kc_ads"]]);
    await show({ filter: ["kc_seo", "kc_ads"] });
    assert.deepEqual(reads.at(-1), { collections: "kc_ads,kc_seo" });
    assert.equal([...chips.querySelectorAll("button")].find((b) => b.textContent === "All")?.getAttribute("aria-pressed"), "false");
  });

  it("reads again when the knowledge changes", async () => {
    await show();
    assert.equal(reads.length, 1);
    await act(async () => knowledgeStore.setState((s) => ({ graphRevision: s.graphRevision + 1 })));
    await settle();
    await act(async () => knowledgeStore.setState((s) => ({ entriesRevision: s.entriesRevision + 1 })));
    await settle();
    assert.equal(reads.length, 3);
  });

  it("says so while it looks, and when there is nothing to point out", async () => {
    let release: (value: KnowledgeInsightsResponse) => void = () => undefined;
    answer = () => new Promise((resolve) => (release = resolve));
    await show();
    assert.match(text(), /Looking for insights…/);
    await act(async () => release(EMPTY));
    await settle();
    assert.match(text(), /Nothing to point out yet/);
    assert.equal(doc().querySelector("section[data-insights-section]"), null);
  });

  it("says each empty section has none while another has items", async () => {
    answer = async () => ({ ...EMPTY, gaps: INSIGHTS.gaps, totals: { ...EMPTY.totals, gaps: 1 } });
    await show();
    assert.match(section("Contradictions").textContent!, /No two entries disagree\./);
    assert.match(section("Bridges").textContent!, /No entry links clusters yet\./);
  });

  it("shows a refusal with Retry, and keeps what it holds when a later read fails", async () => {
    answer = async () => {
      throw Object.assign(new Error("500"), { status: 500, body: { code: "KNOWLEDGE_ERROR", message: "The index is being rebuilt." } });
    };
    await show();
    assert.equal(doc().querySelector('[role="alert"]')?.textContent, "The index is being rebuilt.");
    answer = async () => INSIGHTS;
    await click([...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry")!);
    assert.equal(doc().querySelector('[role="alert"]'), null);
    assert.ok(section("Contradictions"));

    answer = async () => {
      throw Object.assign(new Error("500"), { status: 500, body: { code: "KNOWLEDGE_ERROR", message: "Busy." } });
    };
    await act(async () => knowledgeStore.setState((s) => ({ graphRevision: s.graphRevision + 1 })));
    await settle();
    assert.equal(doc().querySelector('[role="alert"]')?.textContent, "Busy.");
    assert.ok(section("Contradictions"), "the last answer stays");
    assert.equal(unsupported, 0);
  });

  it("tells the Knowledge view when the daemon has no such route", async () => {
    answer = async () => {
      throw missingRoute();
    };
    await show();
    assert.equal(unsupported, 1);
    assert.equal(doc().querySelector('[role="alert"]'), null, "no error: the view is withdrawn");
  });
});
