// Phase 2 wire validation (phase 2 spec, "U — UI"): every new field is optional (an older daemon
// sends none), a malformed item is left out on its own, and a broken envelope reads as nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knowledgeRoutes } from "@orquester/api";

import {
  parseKnowledgeConceptMergesResponse,
  parseKnowledgeInsightsResponse,
  parseKnowledgeItemResponse,
  parseKnowledgeSimilarityGraphResponse,
  parseKnowledgeStatus
} from "./validate.ts";
import { ApiClient } from "../api-client.ts";
import type { Transporter } from "../transporter.ts";
import { entry, status, summary } from "./fixtures.test-helpers.ts";

const ref = (id: string, name = `Name ${id}`, type = "Tactic") => ({ id, name, type });
const A = summary({ id: "ke_aaaaaaaaaaaa", title: "A" });
const B = summary({ id: "ke_bbbbbbbbbbbb", title: "B" });

const fakeClient = () => {
  let answer: unknown = null;
  const requests: { method: string; path: string; query?: Record<string, unknown> }[] = [];
  const transporter = {
    kind: "fake",
    request: async (req: { method: string; path: string; query?: Record<string, unknown> }) => {
      requests.push(req);
      return { status: 200, ok: true, data: answer };
    },
    openStream: () => ({ close: () => undefined })
  } as unknown as Transporter;
  return { client: new ApiClient({ id: "c1" } as never, transporter), requests, answer: (value: unknown) => void (answer = value) };
};

/** A reason as the panel gets it: through an entry item's similar list (the reason parser is private). */
const parseKnowledgeRelatedReason = (reason: unknown) => {
  const item = parseKnowledgeItemResponse({
    kind: "entry",
    entry: { entry: entry(), concepts: [], related: [], citation: "c", similar: [{ entry: summary({ id: "ke_rrrrrrrrrrrr" }), similarity: null, reasons: [reason] }] }
  });
  return item?.kind === "entry" ? (item.entry.similar?.[0]?.reasons[0] ?? null) : null;
};

describe("phase 2 wire validation", () => {
  describe("related reasons", () => {
    it("reads a contradiction, repairing its source and note and dropping unreadable pairs", () => {
      assert.deepEqual(
        parseKnowledgeRelatedReason({ kind: "contradicts", source: "checked", pairs: [{ from: ref("t-a"), to: ref("t-b") }], note: " They disagree on price. " }),
        { kind: "contradicts", source: "checked", pairs: [{ from: ref("t-a"), to: ref("t-b") }], note: "They disagree on price." }
      );
      assert.deepEqual(
        parseKnowledgeRelatedReason({ kind: "contradicts", source: "llm-v2", pairs: [{ from: ref("t-a") }, "x", { from: ref("t-a"), to: ref("t-c") }], note: "" }),
        { kind: "contradicts", source: "graph", pairs: [{ from: ref("t-a"), to: ref("t-c") }], note: null },
        "an unknown source reads as the graph's; an empty note as none"
      );
      assert.deepEqual(parseKnowledgeRelatedReason({ kind: "contradicts" }), { kind: "contradicts", source: "graph", pairs: [], note: null });
    });

    it("reads the distinctive concepts of a concepts reason, absent from an older daemon", () => {
      assert.deepEqual(parseKnowledgeRelatedReason({ kind: "concepts", concepts: [ref("t-a")], shared: 1 }), { kind: "concepts", concepts: [ref("t-a")], shared: 1 });
      assert.deepEqual(
        parseKnowledgeRelatedReason({ kind: "concepts", concepts: [ref("t-a")], shared: 1, distinctive: [ref("t-a"), { name: "no id" }, ref("t-a")] }),
        { kind: "concepts", concepts: [ref("t-a")], shared: 1, distinctive: [ref("t-a")] }
      );
      const notAList = parseKnowledgeRelatedReason({ kind: "concepts", concepts: [], shared: 0, distinctive: "t-a" });
      assert.ok(notAList?.kind === "concepts" && !("distinctive" in notAList), "anything but a list reads as absent");
    });
  });

  describe("entry and concept details", () => {
    const entryItem = (extra: Record<string, unknown>) => ({ kind: "entry", entry: { entry: entry(), concepts: [], related: [], citation: "c", ...extra } });
    const conceptItem = (extra: Record<string, unknown>) => ({
      kind: "concept",
      concept: { concept: { ...ref("t-kept"), confidence: 0.9, description: null, aliases: [], attributes: {} }, collections: [], entries: [], neighbors: [], ...extra }
    });

    it("reads novelty, absent from an older daemon", () => {
      const older = parseKnowledgeItemResponse(entryItem({}));
      assert.ok(older?.kind === "entry" && !("novelty" in older.entry));
      const read = parseKnowledgeItemResponse(entryItem({ novelty: { newConcepts: [ref("t-a"), 7, ref("t-a")], cluster: { label: "Paywalls", size: 12 } } }));
      assert.ok(read?.kind === "entry");
      assert.deepEqual(read.entry.novelty, { newConcepts: [ref("t-a")], cluster: { label: "Paywalls", size: 12 } });
      const repaired = parseKnowledgeItemResponse(entryItem({ novelty: { newConcepts: "x", cluster: { label: " ", size: 3 } } }));
      assert.ok(repaired?.kind === "entry");
      assert.deepEqual(repaired.entry.novelty, { newConcepts: [], cluster: { label: null, size: 3 } });
      // A cluster without a whole size of one or more is no cluster ("a cluster of 0 entries").
      for (const size of [-3, 0, 2.5, Number.NaN, "12", undefined]) {
        const odd = parseKnowledgeItemResponse(entryItem({ novelty: { newConcepts: [], cluster: { label: "Paywalls", size } } }));
        assert.ok(odd?.kind === "entry");
        assert.equal(odd.entry.novelty?.cluster, null, `size ${String(size)}`);
      }
      const noCluster = parseKnowledgeItemResponse(entryItem({ novelty: { newConcepts: [], cluster: "big" } }));
      assert.ok(noCluster?.kind === "entry");
      assert.deepEqual(noCluster.entry.novelty, { newConcepts: [], cluster: null });
      const broken = parseKnowledgeItemResponse(entryItem({ novelty: "new" }));
      assert.ok(broken?.kind === "entry" && !("novelty" in broken.entry));
    });

    it("reads disagreements, never the entry itself, each once, with a total only past them; absent from an older daemon", () => {
      const older = parseKnowledgeItemResponse(entryItem({}));
      assert.ok(older?.kind === "entry" && !("disagreements" in older.entry) && !("disagreementsTotal" in older.entry));
      const C = summary({ id: "ke_cccccccccccc", title: "C" });
      const read = parseKnowledgeItemResponse(
        entryItem({
          disagreements: [
            { entry: C, similarity: 0.93, source: "checked", pairs: [{ from: ref("t-a"), to: ref("t-b") }, { from: ref("t-a") }], note: " Gmail vs Outlook. " },
            { entry: A, similarity: 0.9, source: "checked", pairs: [], note: null },
            { entry: B, similarity: "high", source: "llm-v3", note: "" },
            { entry: C, similarity: 0.5, source: "graph", pairs: [], note: null },
            { similarity: 0.9 },
            "B"
          ],
          disagreementsTotal: 40
        })
      );
      assert.ok(read?.kind === "entry");
      assert.deepEqual(read.entry.disagreements, [
        { entry: C, similarity: 0.93, source: "checked", pairs: [{ from: ref("t-a"), to: ref("t-b") }], note: "Gmail vs Outlook." },
        { entry: B, similarity: null, source: "graph", pairs: [], note: null }
      ]);
      assert.equal(read.entry.disagreementsTotal, 40);
      const fewer = parseKnowledgeItemResponse(entryItem({ disagreements: [{ entry: C, similarity: null, source: "graph", pairs: [], note: null }], disagreementsTotal: 1 }));
      assert.ok(fewer?.kind === "entry" && !("disagreementsTotal" in fewer.entry), "a total no larger than the list says nothing");
      const broken = parseKnowledgeItemResponse(entryItem({ disagreements: "all" }));
      assert.ok(broken?.kind === "entry" && !("disagreements" in broken.entry));
    });

    it("reads merged-from and similar concepts, never the concept itself, each once", () => {
      const older = parseKnowledgeItemResponse(conceptItem({}));
      assert.ok(older?.kind === "concept" && !("mergedFrom" in older.concept) && !("similarConcepts" in older.concept));
      const read = parseKnowledgeItemResponse(
        conceptItem({
          mergedFrom: [ref("t-dup"), ref("t-kept"), { id: "" }, ref("t-dup")],
          similarConcepts: [
            { concept: ref("t-near"), similarity: 0.83 },
            { concept: ref("t-near"), similarity: 0.8 },
            { concept: ref("t-kept"), similarity: 1 },
            { concept: ref("t-far"), similarity: 1.4 },
            { concept: ref("t-bad"), similarity: "high" },
            { similarity: 0.7 }
          ]
        })
      );
      assert.ok(read?.kind === "concept");
      assert.deepEqual(read.concept.mergedFrom, [ref("t-dup")]);
      assert.deepEqual(read.concept.similarConcepts, [
        { concept: ref("t-near"), similarity: 0.83 },
        { concept: ref("t-far"), similarity: 1 }
      ]);
    });

    it("reads a concept's summary: text required, malformed or repeated positions left out, absent from an older daemon", () => {
      const older = parseKnowledgeItemResponse(conceptItem({}));
      assert.ok(older?.kind === "concept" && !("summary" in older.concept));
      const read = parseKnowledgeItemResponse(
        conceptItem({
          summary: {
            text: "Using a new account normally before posting.",
            positions: [
              { entryId: "ke_a", title: "Guide", author: "Alex", claim: "First video after 1–2 days." },
              { entryId: "ke_b", title: 7, author: "", claim: "Warm up 3–5 days." },
              { entryId: "ke_a", title: "Again", author: null, claim: "A second position of one entry." },
              { entryId: "ke_c", title: "No claim", author: null, claim: " " },
              { title: "No id", claim: "x" },
              "ke_d"
            ]
          }
        })
      );
      assert.ok(read?.kind === "concept");
      assert.deepEqual(read.concept.summary, {
        text: "Using a new account normally before posting.",
        positions: [
          { entryId: "ke_a", title: "Guide", author: "Alex", claim: "First video after 1–2 days." },
          { entryId: "ke_b", title: "", author: null, claim: "Warm up 3–5 days." }
        ]
      });
      for (const broken of [{ text: "" }, { positions: [] }, "text", { text: 5, positions: [] }]) {
        const item = parseKnowledgeItemResponse(conceptItem({ summary: broken }));
        assert.ok(item?.kind === "concept" && !("summary" in item.concept), JSON.stringify(broken));
      }
      const noPositions = parseKnowledgeItemResponse(conceptItem({ summary: { text: "Google's email service.", positions: "none" } }));
      assert.ok(noPositions?.kind === "concept");
      assert.deepEqual(noPositions.concept.summary, { text: "Google's email service.", positions: [] });
    });

    it("reads a concept's family: id, name and two members required, each member once; its summary as a concept summary's; absent from an older daemon", () => {
      const older = parseKnowledgeItemResponse(conceptItem({}));
      assert.ok(older?.kind === "concept" && !("family" in older.concept));
      const member = (id: string) => ({ id, name: id, type: "Tactic" });
      const read = parseKnowledgeItemResponse(
        conceptItem({
          family: {
            id: "family-0123456789ab",
            name: "Warm-up length before the first post",
            concepts: [member("t-a"), member("t-b"), member("t-a"), { id: 5 }, "t-c"],
            summary: { text: "How long a new account is used normally.", positions: [{ entryId: "ke_a", title: "Guide", author: null, claim: "48 hours." }, { entryId: "ke_a", claim: "again" }] },
            extra: true
          }
        })
      );
      assert.ok(read?.kind === "concept");
      assert.deepEqual(read.concept.family, {
        id: "family-0123456789ab",
        name: "Warm-up length before the first post",
        concepts: [member("t-a"), member("t-b")],
        summary: { text: "How long a new account is used normally.", positions: [{ entryId: "ke_a", title: "Guide", author: null, claim: "48 hours." }] }
      });
      const unnamed = parseKnowledgeItemResponse(conceptItem({ family: { id: "f", name: "Concepts answering the same question", concepts: [member("t-a"), member("t-b")], summary: { text: "" } } }));
      assert.ok(unnamed?.kind === "concept");
      assert.deepEqual(unnamed.concept.family, { id: "f", name: "Concepts answering the same question", concepts: [member("t-a"), member("t-b")] }, "a broken summary is left out, the family kept");
      for (const broken of [
        { name: "x", concepts: [member("t-a"), member("t-b")] },
        { id: "f", name: " ", concepts: [member("t-a"), member("t-b")] },
        { id: "f", name: "x", concepts: [member("t-a"), member("t-a")] },
        { id: "f", name: "x", concepts: "t-a" },
        "family"
      ]) {
        const item = parseKnowledgeItemResponse(conceptItem({ family: broken }));
        assert.ok(item?.kind === "concept" && !("family" in item.concept), JSON.stringify(broken));
      }
    });

    it("reads every visible entry id of a concept, each once, absent from an older daemon", () => {
      const older = parseKnowledgeItemResponse(conceptItem({}));
      assert.ok(older?.kind === "concept" && !("entryIds" in older.concept));
      const read = parseKnowledgeItemResponse(conceptItem({ entryIds: ["ke_b", "ke_a", 7, "", null, "ke_b", "ke_c"] }));
      assert.ok(read?.kind === "concept");
      assert.deepEqual(read.concept.entryIds, ["ke_b", "ke_a", "ke_c"], "in the daemon's order (newest first)");
      const broken = parseKnowledgeItemResponse(conceptItem({ entryIds: "ke_a" }));
      assert.ok(broken?.kind === "concept" && !("entryIds" in broken.concept), "not a list: as from an older daemon");
    });
  });

  describe("the similarity graph", () => {
    const node = (id: string) => ({ id, title: id, kind: "post", author: null, handle: null, savedAt: "", collections: [], cluster: 0, degree: 1 });

    it("reads shared concepts, contradictions and cluster concepts, absent from an older daemon", () => {
      const older = parseKnowledgeSimilarityGraphResponse({
        nodes: [node("ke_a"), node("ke_b")],
        edges: [{ from: "ke_a", to: "ke_b", similarity: 0.9, tree: true }],
        clusters: [{ id: 0, size: 2, label: "Paywalls" }]
      });
      assert.deepEqual(older?.edges, [{ from: "ke_a", to: "ke_b", similarity: 0.9, tree: true }]);
      assert.deepEqual(older?.clusters, [{ id: 0, size: 2, label: "Paywalls" }]);

      const read = parseKnowledgeSimilarityGraphResponse({
        nodes: [node("ke_a"), node("ke_b"), node("ke_c")],
        edges: [
          { from: "ke_a", to: "ke_b", similarity: 0.9, tree: true, sharedConcepts: 3.6, contradicts: false },
          { from: "ke_b", to: "ke_a", similarity: 0.9, tree: false, contradicts: true },
          { from: "ke_b", to: "ke_c", similarity: 0.7, tree: false, sharedConcepts: "many", contradicts: "yes" }
        ],
        clusters: [{ id: 0, size: 3, label: "Paywalls", concepts: [ref("t-1"), ref("t-1"), "x", ref("t-2"), ref("t-3"), ref("t-4"), ref("t-5"), ref("t-6")] }]
      });
      assert.deepEqual(read?.edges, [
        { from: "ke_a", to: "ke_b", similarity: 0.9, tree: true, sharedConcepts: 3, contradicts: true },
        { from: "ke_b", to: "ke_c", similarity: 0.7, tree: false }
      ]);
      assert.deepEqual(
        read?.clusters[0]?.concepts?.map((c) => c.id),
        ["t-1", "t-2", "t-3", "t-4", "t-5"],
        "each once, up to five"
      );
    });
  });

  describe("concept merges", () => {
    it("reads merges, leaving out what it cannot read", () => {
      const merge = { id: "cm_1", into: ref("t-kept"), merged: [ref("t-dup")], similarity: 0.94, createdAt: "2026-10-27T10:00:00.000Z" };
      assert.deepEqual(parseKnowledgeConceptMergesResponse({ merges: [merge] }), { merges: [merge] });
      assert.deepEqual(
        parseKnowledgeConceptMergesResponse({
          merges: [
            { ...merge, merged: [ref("t-dup"), ref("t-kept"), { id: 3 }], similarity: "x", createdAt: 5 },
            { id: "cm_2", merged: [] },
            { into: ref("t-x") },
            "cm_3"
          ]
        }),
        { merges: [{ id: "cm_1", into: ref("t-kept"), merged: [ref("t-dup")], similarity: 0, createdAt: "" }] }
      );
      assert.equal(parseKnowledgeConceptMergesResponse({ merges: "none" }), null);
      assert.equal(parseKnowledgeConceptMergesResponse([]), null);
    });
  });

  describe("insights", () => {
    const full = {
      contradictions: [{ a: A, b: B, similarity: 0.71, source: "checked", pairs: [{ from: ref("t-a"), to: ref("t-b") }], note: "A says 3 days, B says a week." }],
      bridges: [{ entry: A, clusters: [{ label: "Paywalls", size: 9 }, { label: null, size: 4 }], concepts: [ref("t-a")] }],
      singleSource: [{ concept: ref("r-1", "Never discount", "Rule"), entry: B, cluster: { label: "Pricing", size: 5 } }],
      gaps: [{ a: A, b: B, similarity: 0.88, queued: true }],
      totals: { contradictions: 1, bridges: 1, singleSource: 1, gaps: 7 }
    };

    it("reads a well-formed answer as it is", () => {
      assert.deepEqual(parseKnowledgeInsightsResponse(full), full);
    });

    it("drops malformed items, repairs fields and never counts fewer than it lists", () => {
      const parsed = parseKnowledgeInsightsResponse({
        contradictions: [
          { a: A, b: A, source: "graph", pairs: [] },
          { a: A, source: "graph" },
          { a: A, b: B, similarity: "close", source: "new-kind", pairs: "x", note: "  " }
        ],
        bridges: [
          { entry: { title: "no id" } },
          { entry: B, clusters: [{ label: 5, size: 2 }, "x", { label: "Empty", size: 0 }, { label: "Half", size: 1.5 }, { label: "None" }], concepts: [ref("t-a"), ref("t-a")] }
        ],
        singleSource: [
          { concept: ref("r-1") },
          { concept: ref("r-1"), entry: A, cluster: "x" },
          { concept: ref("r-2"), entry: A, cluster: { label: "Negative", size: -4 } }
        ],
        gaps: [{ a: A, b: B }, { a: A, b: B, similarity: 0.9, queued: "yes" }],
        totals: { contradictions: "many", bridges: 0, singleSource: -1 }
      });
      assert.ok(parsed);
      assert.deepEqual(parsed.contradictions, [{ a: A, b: B, similarity: null, source: "graph", pairs: [], note: null }]);
      assert.deepEqual(parsed.bridges, [{ entry: B, clusters: [{ label: null, size: 2 }], concepts: [ref("t-a")] }]);
      assert.deepEqual(parsed.singleSource, [
        { concept: ref("r-1"), entry: A, cluster: null },
        { concept: ref("r-2"), entry: A, cluster: null }
      ]);
      assert.deepEqual(parsed.gaps, [{ a: A, b: B, similarity: 0.9, queued: false }], "a gap needs its similarity");
      assert.deepEqual(parsed.totals, { contradictions: 1, bridges: 1, singleSource: 2, gaps: 1 });
    });

    it("reads the entries a contradiction folds in (`also`), never one of its own sides, and none as absent", () => {
      const C = { ...A, id: "ke_cccccccccccc", title: "Third" };
      const read = (also: unknown) => parseKnowledgeInsightsResponse({ ...full, contradictions: [{ ...full.contradictions[0], also }] })!.contradictions[0]!;
      assert.deepEqual(read([C]).also, [C]);
      assert.deepEqual(read([C, A, { title: "no id" }]).also, [C], "a side of the pair or a broken summary is dropped");
      assert.equal("also" in read([]), false);
      assert.equal("also" in read("x"), false);
    });

    it("reads a missing list as empty, and refuses a broken envelope", () => {
      assert.deepEqual(parseKnowledgeInsightsResponse({ gaps: [] }), {
        contradictions: [],
        bridges: [],
        singleSource: [],
        gaps: [],
        totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 }
      });
      assert.equal(parseKnowledgeInsightsResponse(null), null);
      assert.equal(parseKnowledgeInsightsResponse("<html>"), null);
      assert.equal(parseKnowledgeInsightsResponse({ totals: { gaps: 3 } }), null, "none of the lists");
    });
  });

  describe("the status", () => {
    it("reads re-linking and concept merges, absent from an older daemon", () => {
      const older = parseKnowledgeStatus(status());
      assert.ok(older && !("relink" in older) && !("conceptMerges" in older));
      assert.deepEqual(parseKnowledgeStatus(status({ relink: { pending: 89, done: 37, total: 126 }, conceptMerges: 12 }))?.relink, { pending: 89, done: 37, total: 126 });
      assert.equal(parseKnowledgeStatus(status({ conceptMerges: 12 }))?.conceptMerges, 12);
      assert.equal(parseKnowledgeStatus(status({ relink: null }))?.relink, null, "null: nothing left to re-link");
      assert.deepEqual(parseKnowledgeStatus({ ...status(), relink: { pending: 500, done: 200.5, total: 126 } })?.relink, { pending: 126, done: 126, total: 126 });
      const broken = parseKnowledgeStatus({ ...status(), relink: { pending: 3 }, conceptMerges: "12" });
      assert.ok(broken && !("relink" in broken) && !("conceptMerges" in broken));
    });
  });

  describe("the client", () => {
    it("asks for insights with its narrowing and validates the answer", async () => {
      const { client, requests, answer } = fakeClient();
      answer({ contradictions: [], bridges: [], singleSource: [], gaps: [], totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 } });
      const insights = await client.getKnowledgeInsights({ collections: "kc_a,kc_b", limit: 5 });
      assert.deepEqual(insights.gaps, []);
      assert.equal(requests[0]!.method, "GET");
      assert.ok(requests[0]!.path.startsWith(knowledgeRoutes.insights), requests[0]!.path);
      assert.match(JSON.stringify(requests[0]), /kc_a,kc_b|kc_a%2Ckc_b/);
      answer("<html>");
      await assert.rejects(client.getKnowledgeInsights(), /knowledge insights this app cannot read/);
    });

    it("lists concept merges and undoes one by id", async () => {
      const { client, requests, answer } = fakeClient();
      answer({ merges: [{ id: "cm_1", into: ref("t-kept"), merged: [ref("t-dup")], similarity: 0.9, createdAt: "" }] });
      const { merges } = await client.listKnowledgeConceptMerges();
      assert.deepEqual(
        merges.map((m) => m.id),
        ["cm_1"]
      );
      assert.equal(requests[0]!.path, knowledgeRoutes.conceptMerges);
      answer({});
      await client.undoKnowledgeConceptMerge("cm/1");
      assert.equal(requests[1]!.method, "DELETE");
      assert.equal(requests[1]!.path, knowledgeRoutes.conceptMerge("cm/1"));
      assert.equal(requests[1]!.path, "/api/knowledge/concepts/merges/cm%2F1", "the id is encoded");
      answer({ merges: "x" });
      await assert.rejects(client.listKnowledgeConceptMerges(), /knowledge concept merges this app cannot read/);
    });
  });
});
