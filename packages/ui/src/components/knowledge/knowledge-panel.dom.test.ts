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
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  type KnowledgeConceptDetail,
  type KnowledgeConceptMerge,
  type KnowledgeEntryDetail,
  type KnowledgeItemResponse,
  type KnowledgeMergeRequest,
  type UpdateKnowledgeEntryRequest
} from "@orquester/api";

import { collection, collections, entry, event, status, summary } from "../../lib/knowledge/fixtures.test-helpers";
import type { KnowledgeSelection } from "./KnowledgePanel";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let resetKnowledge: typeof import("../../lib/knowledge/store").resetKnowledge;
let applyKnowledgeEvent: typeof import("../../lib/knowledge/store").applyKnowledgeEvent;
let knowledgeStore: typeof import("../../lib/knowledge/store").knowledgeStore;
let setPlainTextBody: typeof import("./panel.logic").setPlainTextBody;
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
  ({ resetKnowledge, applyKnowledgeEvent, knowledgeStore } = await import("../../lib/knowledge/store"));
  ({ setPlainTextBody } = await import("./panel.logic"));
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

let OPEN: string;
let OLDER: string;
let fixtureId = 0;
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
  let selected: Array<KnowledgeSelection & { replaced?: boolean }>;
  let similarAsked: string[];
  let items: Map<string, KnowledgeItemResponse>;
  let failMerge: boolean;
  let failUndo: boolean;
  let merges: KnowledgeConceptMerge[];
  let renders = 0;

  const api = {
    connection: { id: "c1" },
    getKnowledgeStatus: async () => {
      calls.push("status");
      return status({ conceptMerges: merges.length });
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
    },
    listKnowledgeConceptMerges: async () => {
      calls.push("merges");
      return { merges };
    },
    undoKnowledgeConceptMerge: async (id: string) => {
      calls.push(`undo:${id}`);
      if (failUndo) throw Object.assign(new Error("500"), { status: 500, body: { code: "KNOWLEDGE_ERROR", message: "The graph is being reloaded." } });
      const merge = merges.find((m) => m.id === id)!;
      merges = merges.filter((m) => m.id !== id);
      const kept = items.get(merge.into.id);
      if (kept?.kind === "concept") {
        const gone = new Set(merge.merged.map((c) => c.id));
        items.set(merge.into.id, { kind: "concept", concept: { ...kept.concept, mergedFrom: (kept.concept.mergedFrom ?? []).filter((c) => !gone.has(c.id)) } });
      }
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
    const suffix = String(++fixtureId).padStart(9, "0");
    OPEN = `ke_new${suffix}`;
    OLDER = `ke_old${suffix}`;
    failUndo = false;
    merges = [];
    items = new Map();
    resetKnowledge();
    setPlainTextBody(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetKnowledge();
    setPlainTextBody(false);
  });

  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    });
  };

  const show = async (detail: KnowledgeEntryDetail | KnowledgeConceptDetail, opts: { findSimilar?: boolean; api?: object } = {}) => {
    const first: KnowledgeSelection =
      "concept" in detail ? { kind: "concept", id: detail.concept.id } : { kind: "entry", id: detail.entry.id };
    if ("concept" in detail) items.set(detail.concept.id, { kind: "concept", concept: detail });
    else items.set(detail.entry.id, { kind: "entry", entry: detail });
    // Holds the selection as the Knowledge view does.
    const Host = () => {
      const [selection, setSelection] = useState<KnowledgeSelection>(first);
      return createElement(KnowledgePanel, {
        api: (opts.api ?? api) as never,
        selection,
        collections: COLLECTIONS,
        onSelect: (next: KnowledgeSelection, options?: { replace?: boolean }) => {
          selected.push(options?.replace ? { ...next, replaced: true } : next);
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
    assert.equal((body.querySelector("img")) === null, true, "raw HTML is not rendered");

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

  it("loads a remote image in the body only when clicked (no tracking pixel on open)", async () => {
    await show(openDetail({ entry: entry({ id: OPEN, body: "Saved post.\n\n![pixel](https://tracker.example/p.gif)" }) }));
    const body = doc().querySelector('[data-knowledge-body="markdown"]')!;
    assert.equal((body.querySelector("img")) === null, true, "nothing is requested on open");
    const load = [...body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Load image"));
    assert.ok(load, "a click-to-load button stands in");
    assert.equal(load.textContent, "Load image: pixel (tracker.example)");
    assert.equal(load.getAttribute("title"), "https://tracker.example/p.gif");
    await click(load);
    assert.equal(body.querySelector("img")?.getAttribute("src"), "https://tracker.example/p.gif");
  });

  it("cuts a long body's Markdown until asked for the rest", async () => {
    const long = `First paragraph.\n\n${"Saved words. ".repeat(2000)}\n\nFinal paragraph remains intact.`;
    await show(openDetail({ entry: entry({ id: OPEN, body: long }) }));
    const more = [...doc().querySelectorAll("button")].find((b) => /^Show the rest/.test(b.textContent ?? ""));
    assert.ok(more, "a long body offers the rest");
    assert.match(text(), /First paragraph/);
    assert.doesNotMatch(text(), /Final paragraph remains intact/);
    await click(more);
    assert.match(text(), /Final paragraph remains intact/);
  });

  it("lists similar entries with their reasons, opens one, and offers More like this", async () => {
    await show(openDetail());
    const section = doc().querySelector('section[aria-label="Similar entries"]');
    assert.ok(section);
    const row = section.querySelector(`[data-knowledge-similar="${SIMILAR}"]`);
    assert.ok(row);
    assert.match(row.textContent!, /Meaning 91%/);
    assert.match(row.textContent!, /Concepts: A, B/);
    assert.match(row.textContent!, /Same author/);
    assert.ok([...row.querySelectorAll("[title]")].some((item) => item.getAttribute("title")?.includes("Hridoy")), "the shared author is identified");
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
    assert.match(section?.textContent ?? "", /Related one/);
    assert.match(section?.textContent ?? "", /Shared concepts/);
    assert.equal((doc().querySelector('section[aria-label="Possible duplicates"]')) === null, true);
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
    assert.equal((doc().querySelector('section[aria-label="Possible duplicates"]')) === null, true);
    await show(openDetail());
    assert.equal((doc().querySelector('section[aria-label="Possible duplicates"]')) === null, true, "still hidden");
    await show(openDetail({
      entry: entry({ id: OLDER, title: "Original" }),
      possibleDuplicates: [{ entry: summary({ id: OPEN, title: "Copy" }), similarity: 0.97, reasons: [] }]
    }));
    assert.equal((doc().querySelector('section[aria-label="Possible duplicates"]')) === null, true, "the same pair stays hidden from the other entry");
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
    assert.deepEqual(selected, [{ kind: "entry", id: OLDER, replaced: true }], "in the deleted entry's place: Back does not lead to it");
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
    assert.match(alert?.textContent ?? "", /Nothing was merged/i);
    assert.ok(alert?.textContent?.includes(`No such entry: ${OLDER}`));
  });

  describe("phase 2: disagreements, distinctive concepts, novelty", () => {
    const DISAGREES = "ke_dis000000000";
    const pair = { from: { id: "tactic-short", name: "Short trial", type: "Tactic" }, to: { id: "tactic-long", name: "Long trial", type: "Tactic" } };
    const phase2 = (overrides: Partial<KnowledgeEntryDetail> = {}) =>
      openDetail({
        concepts: [{ id: "tactic-short", name: "Short trial", type: "Tactic" }],
        similar: [
          {
            entry: summary({ id: SIMILAR, title: "A close one" }),
            similarity: 0.91,
            reasons: [
              { kind: "meaning", similarity: 0.91 },
              {
                kind: "concepts",
                concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }, { id: "tactic-b", name: "B", type: "Tactic" }],
                shared: 2,
                distinctive: [{ id: "tactic-b", name: "B", type: "Tactic" }]
              }
            ]
          },
          {
            entry: summary({ id: DISAGREES, title: "Long trials win" }),
            similarity: 0.4,
            reasons: [{ kind: "contradicts", source: "checked", pairs: [pair], note: "<i>Seven days</i> against thirty." }]
          }
        ],
        possibleDuplicates: [],
        novelty: { newConcepts: [{ id: "tactic-short", name: "Short trial", type: "Tactic" }], cluster: { label: "Trials", size: 6 } },
        ...overrides
      });

    it("shows Disagrees with above Similar: the note as text, the clashing concepts, each opening", async () => {
      await show(phase2());
      const sections = [...doc().querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"));
      assert.ok(sections.indexOf("Disagrees with") >= 0 && sections.indexOf("Disagrees with") < sections.indexOf("Similar entries"), sections.join(", "));
      const section = doc().querySelector('section[aria-label="Disagrees with"]')!;
      const row = section.querySelector(`[data-knowledge-disagrees="${DISAGREES}"]`)!;
      assert.match(row.textContent!, /Long trials win/);
      assert.match(row.textContent!, /<i>Seven days<\/i> against thirty\./, "the note, as text");
      assert.equal((row.querySelector("i")) === null, true);
      assert.match(row.textContent!, /Short trial≠Long trial/);
      assert.match(row.textContent!, /Checked by an agent/);
      await click(buttonNamed("Long trial", row));
      assert.deepEqual(selected, [{ kind: "concept", id: "tactic-long" }]);

      await show(phase2());
      const entryButton = [...doc().querySelectorAll('section[aria-label="Disagrees with"] button')].find((b) => b.textContent?.startsWith("Long trials win"));
      assert.ok(entryButton);
      await click(entryButton);
      assert.deepEqual(selected.at(-1), { kind: "entry", id: DISAGREES });
    });

    it("marks the distinctive shared concepts, and the disagreeing entry among the similar ones", async () => {
      await show(phase2());
      const similar = doc().querySelector('section[aria-label="Similar entries"]')!;
      const row = similar.querySelector(`[data-knowledge-similar="${SIMILAR}"]`)!;
      const distinctive = [...row.querySelectorAll("[data-knowledge-distinctive]")];
      assert.deepEqual(
        distinctive.map((chip) => [chip.getAttribute("data-knowledge-distinctive"), chip.textContent]),
        [["tactic-b", "B"]]
      );
      assert.match(distinctive[0]!.getAttribute("title") ?? "", /few entries share it/);
      assert.match(similar.querySelector(`[data-knowledge-similar="${DISAGREES}"]`)!.textContent!, /Disagrees/);
    });

    it("says what is new here and which cluster it joins; nothing from an older daemon", async () => {
      await show(phase2());
      const line = doc().querySelector("[data-knowledge-novelty]")!;
      assert.match(line.textContent!, /New here:\s*Short trial\s*· Part of “Trials” \(6 entries\)/);
      await click(buttonNamed("Short trial", line));
      assert.deepEqual(selected, [{ kind: "concept", id: "tactic-short" }]);

      const { novelty: _novelty, ...older } = phase2({ similar: [] });
      await show(older);
      assert.equal((doc().querySelector("[data-knowledge-novelty]")) === null, true);
      assert.equal((doc().querySelector('section[aria-label="Disagrees with"]')) === null, true);
    });
  });

  describe("phase 2: the concept panel", () => {
    const KEPT = "tactic-pricing";
    const concept = (overrides: Partial<KnowledgeConceptDetail> = {}): KnowledgeConceptDetail => ({
      concept: { id: KEPT, name: "Pricing page", type: "Tactic", confidence: 0.9, description: null, aliases: ["Prices page"], attributes: {} },
      collections: [],
      entries: [],
      neighbors: [],
      mergedFrom: [
        { id: "tactic-prices", name: "Prices page", type: "Tactic" },
        { id: "tactic-plans", name: "Plans page", type: "Tactic" }
      ],
      similarConcepts: [{ concept: { id: "tactic-pricing-test", name: "Pricing test", type: "Tactic" }, similarity: 0.81 }],
      ...overrides
    });
    const merge = (id: string, merged: string[]): KnowledgeConceptMerge => ({
      id,
      into: { id: KEPT, name: "Pricing page", type: "Tactic" },
      merged: merged.map((m) => ({ id: m, name: m, type: "Tactic" })),
      similarity: 0.93,
      createdAt: "2026-10-27T10:00:00.000Z"
    });
    const mergedRow = (id: string) => doc().querySelector(`[data-knowledge-merged="${id}"]`);

    it("shows the neutral summary and each entry's position, attributed, each opening its entry; the extracted description below it", async () => {
      await show(
        concept({
          concept: { id: KEPT, name: "Pricing page", type: "Tactic", confidence: 0.9, description: "Show three plans, annual first.", aliases: [], attributes: {} },
          summary: {
            text: "A page that lists a product's plans and prices.",
            positions: [
              { entryId: "ke_aaaaaaaaaaaa", title: "Paywall teardown", author: "Alex Nguyen", claim: "Show three plans with annual first." },
              { entryId: "ke_bbbbbbbbbbbb", title: "", author: null, claim: "One plan converts better under $10." }
            ]
          }
        })
      );
      assert.equal(doc().querySelector("[data-knowledge-summary]")?.textContent, "A page that lists a product's plans and prices.");
      assert.match(doc().body.textContent!, /As extracted: Show three plans, annual first\./);
      const section = doc().querySelector('section[aria-label="Positions"]')!;
      const rows = [...section.querySelectorAll("[data-knowledge-position]")].map((row) => row.textContent);
      assert.deepEqual(rows, ["Alex Nguyen · Paywall teardownShow three plans with annual first.", "Unknown author · UntitledOne plan converts better under $10."]);
      await click(buttonNamed("Alex Nguyen · Paywall teardown", section));
      assert.deepEqual(selected, [{ kind: "entry", id: "ke_aaaaaaaaaaaa" }]);

      // No summary (an older daemon, or not written yet): the description as before, no positions.
      await show(concept({ concept: { id: KEPT, name: "Pricing page", type: "Tactic", confidence: 0.9, description: "Show three plans, annual first.", aliases: [], attributes: {} } }));
      assert.equal(doc().querySelector("[data-knowledge-summary]"), null);
      assert.equal(doc().querySelector('section[aria-label="Positions"]'), null);
      assert.doesNotMatch(doc().body.textContent!, /As extracted/);
      assert.match(doc().body.textContent!, /Show three plans, annual first\./);
    });

    it("lists similar concepts, each opening", async () => {
      await show(concept());
      const section = doc().querySelector('section[aria-label="Similar concepts"]')!;
      assert.match(section.textContent!, /Pricing test\s*81%/);
      await click(section.querySelector('[data-knowledge-similar-concept="tactic-pricing-test"]')!);
      assert.deepEqual(selected, [{ kind: "concept", id: "tactic-pricing-test" }]);
    });

    it("undoes a merge only once confirmed: finds its id, deletes it, and reads the concept again", async () => {
      merges = [merge("cm_other", ["tactic-plans"]), merge("cm_prices", ["tactic-prices"]), { ...merge("cm_elsewhere", ["tactic-prices"]), into: { id: "x", name: "X", type: "Tactic" } }];
      await show(concept());
      const section = doc().querySelector('section[aria-label="Merged from"]')!;
      assert.match(section.textContent!, /Prices page.*Plans page/);
      await click(buttonNamed("Undo", mergedRow("tactic-prices")!));
      const dialog = doc().querySelector('[role="dialog"]');
      assert.ok(dialog, "asks first");
      assert.match(dialog.textContent ?? "", /“Prices page” becomes a concept of its own again/);
      assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), [], "nothing happens before confirming");

      await click(buttonNamed("Undo merge", dialog));
      await settle();
      assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), ["merges", "undo:cm_prices", "status"], "the merge into this concept that lists it, then the status");
      assert.equal(knowledgeStore.getState().status?.conceptMerges, 2, "the merges count moved");
      assert.equal(calls.filter((c) => c === `get:${KEPT}`).length, 1, "nothing refetched locally");
      // The daemon's knowledge.changed { graph } reads the concept again.
      await act(async () => applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { graph: true })));
      await settle();
      assert.equal(calls.filter((c) => c === `get:${KEPT}`).length, 2, "read again after the daemon's graph event");
      assert.equal((mergedRow("tactic-prices")) === null, true, "no longer merged");
      assert.ok(mergedRow("tactic-plans"));
      assert.equal((doc().querySelector('section[aria-label="Merged from"] [role="alert"]')) === null, true);
    });

    it("cancelling the confirmation changes nothing", async () => {
      merges = [merge("cm_prices", ["tactic-prices"])];
      await show(concept());
      await click(buttonNamed("Undo", mergedRow("tactic-prices")!));
      await click(buttonNamed("Cancel", doc().querySelector('[role="dialog"]')!));
      assert.equal((doc().querySelector('[role="dialog"]')) === null, true);
      assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), []);
    });

    it("says why when the undo is refused, and keeps the merge listed", async () => {
      merges = [merge("cm_prices", ["tactic-prices"]), merge("cm_plans", ["tactic-plans"])];
      failUndo = true;
      await show(concept());
      await click(buttonNamed("Undo", mergedRow("tactic-prices")!));
      await click(buttonNamed("Undo merge", doc().querySelector('[role="dialog"]')!));
      await settle();
      assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), ["merges", "undo:cm_prices"]);
      assert.equal(doc().querySelector('section[aria-label="Merged from"] [role="alert"]')?.textContent, "Could not undo the merge: The graph is being reloaded.");
      assert.ok(mergedRow("tactic-prices"));
    });

    it("reads the concept again when its merge is no longer in effect", async () => {
      merges = [merge("cm_a", ["tactic-a"]), merge("cm_b", ["tactic-b"])];
      await show(concept());
      await click(buttonNamed("Undo", mergedRow("tactic-plans")!));
      await click(buttonNamed("Undo merge", doc().querySelector('[role="dialog"]')!));
      await settle();
      assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), ["merges"], "nothing to delete");
      assert.equal(doc().querySelector('section[aria-label="Merged from"] [role="alert"]')?.textContent, "“Plans page” is no longer merged into this concept.");
      assert.equal(calls.filter((c) => c === `get:${KEPT}`).length, 2);
    });

    it("never undoes another merge into the concept when the clicked one is gone (a stale panel)", async () => {
      // The panel still lists "Plans page"; meanwhile its merge was undone and the only merge into
      // the concept is "Prices page"'s: undoing that one would record it as rejected for good.
      merges = [merge("cm_prices", ["tactic-prices"])];
      await show(concept());
      await click(buttonNamed("Undo", mergedRow("tactic-plans")!));
      await click(buttonNamed("Undo merge", doc().querySelector('[role="dialog"]')!));
      await settle();
      assert.deepEqual(calls.filter((c) => !c.startsWith("get:")), ["merges"], "nothing undone");
      assert.equal(doc().querySelector('section[aria-label="Merged from"] [role="alert"]')?.textContent, "“Plans page” is no longer merged into this concept.");
      assert.equal(calls.filter((c) => c === `get:${KEPT}`).length, 2, "read again");
    });

    it("lists merges without Undo for a client without the routes, and nothing from an older daemon", async () => {
      const { listKnowledgeConceptMerges: _list, undoKnowledgeConceptMerge: _undo, ...older } = api;
      await show(concept(), { api: older });
      assert.ok(mergedRow("tactic-prices"));
      assert.equal(buttons("Undo").length, 0);

      const { mergedFrom: _merged, similarConcepts: _similar, ...olderDaemon } = concept();
      await show(olderDaemon);
      assert.equal((doc().querySelector('section[aria-label="Merged from"]')) === null, true);
      assert.equal((doc().querySelector('section[aria-label="Similar concepts"]')) === null, true);
    });
  });
});
