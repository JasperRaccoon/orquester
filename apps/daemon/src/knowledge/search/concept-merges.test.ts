import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeConceptMergeRecord } from "@orquester/config";
import { EMBEDDING_MODEL_ID } from "../install/pins.ts";
import {
  type ConceptMergeThresholds,
  type PlanConcept,
  KnowledgeConceptMerges,
  conceptMergeId,
  conceptMergeRefusal,
  conceptNameNumbers,
  conceptThresholdsFor,
  keptConcept,
  planConceptMerges
} from "./concept-merges.ts";
import { KnowledgeGraph } from "./graph.ts";
import { FakeEmbedder, FakeEmbedderSource, FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { knowledgeScope } from "./visibility.ts";

const BARS: ConceptMergeThresholds = { merge: 0.91, similar: 0.93 };
const T = (name: string, type = "Tactic") => ({ type, name });

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("the rule: same type, the merge bar, and the name guards", () => {
  const ok = (a: string, b: string, type = "Tactic") => conceptMergeRefusal(T(a, type), T(b, type), 0.95, BARS);
  // Live-graph pairs it merges.
  assert.equal(ok("Warm up TikTok account", "Warm up the TikTok account"), null);
  assert.equal(ok("Card-required trial", "Card-required trials"), null);
  assert.equal(ok("Transparent upstream proxy on the router", "Upstream proxy on router"), null);
  assert.equal(ok("Submit an MCP server to ChatGPT as a plugin", "Submit your MCP server as a plugin in ChatGPT"), null);
  // Type and similarity.
  assert.equal(conceptMergeRefusal(T("Stripe", "Tool"), T("Stripe", "Organization"), 0.99, BARS), "type");
  assert.equal(conceptMergeRefusal(T("Warm up TikTok account"), T("Warm up the TikTok account"), 0.909, BARS), "similarity");
  // Lexical: a name inside a longer one that says more, word swaps, little overlap.
  assert.equal(ok("App Store", "Mac App Store", "Channel"), "lexical");
  assert.equal(ok("TikTok", "TikTok slideshows", "Channel"), "lexical");
  assert.equal(ok("Vercel citations on Gemini", "Replit citations on Gemini", "Result"), "lexical");
  assert.equal(ok("Utah age assurance / parental consent law", "Louisiana age assurance / parental consent law", "Regulation"), "lexical");
  assert.equal(ok("Opt-in visitor-to-trial", "Opt-out visitor-to-trial", "Result"), "lexical");
  assert.equal(ok("Toyota", "Tabari", "Organization"), "lexical");
  // Numbers and item marks.
  assert.equal(ok("48-hour trial", "72-hour trial"), "numbers");
  assert.equal(ok("Guideline 2.4.5(v)", "Guideline 2.4.5(ix)", "Guideline"), "numbers");
  assert.equal(ok("App Completeness (b)", "App Completeness", "Guideline"), "numbers");
  assert.equal(ok("Rejection under 5.1.1", "Rejection under 5.1.1(iii)", "Rejection"), "numbers");
  // Negations and lists.
  assert.equal(ok("Paywall placement with blurred preview", "Paywall placement without blurred preview"), "negation");
  assert.equal(ok("Offer a free trial", "Do not offer a free trial"), "negation");
  assert.equal(ok("Backtrack reminder upsell", "Backtrack reminder and upsell"), "list");
  assert.equal(ok("AI Overviews", "AI Overviews and AI Mode", "Channel"), "lexical");
  // Person: only equal names after normalization.
  assert.equal(ok("Om Patel", "om  patel", "Person"), null);
  assert.equal(ok("Om Patel", "Om Patel Jr", "Person"), "person");
  assert.equal(ok("KCodes7777", "person-personkcodes7777", "Person"), "person");
});

test("numbers and item marks are read from names", () => {
  assert.deepEqual([...conceptNameNumbers("Guideline 2.4.5(iii)")].sort(), ["(iii)", "2.4.5"]);
  assert.deepEqual([...conceptNameNumbers("Warm up for 5-7 days")].sort(), ["5", "7"]);
  assert.deepEqual([...conceptNameNumbers("Parasite SEO (free)")], []);
});

test("thresholds exist for the calibrated model only", () => {
  assert.deepEqual(conceptThresholdsFor(EMBEDDING_MODEL_ID), BARS);
  assert.equal(conceptThresholdsFor("Xenova/all-MiniLM-L6-v2"), null);
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** A unit vector at `similarity` to axis 0, leaning towards `axis`. */
function around(similarity: number, axis: number, dims = 8): Float32Array {
  const v = new Float32Array(dims);
  v[0] = similarity;
  v[axis] = Math.sqrt(1 - similarity * similarity);
  return v;
}

const c = (id: string, name: string, entryCount = 1, type = "Tactic"): PlanConcept => ({ id, type, name, entryCount });
const noPause = async (): Promise<void> => undefined;

test("merges are transitive within a type; the kept concept has the most entries, then the shortest name, then the smallest id", async () => {
  const concepts = [
    c("tactic-a", "Warm up the TikTok account", 1),
    c("tactic-b", "Warm up TikTok account", 1),
    c("tactic-c", "Warm up the TikTok account for days", 2),
    c("tool-x", "Warm up TikTok account", 5, "Tool")
  ];
  // a·b and b·c pass, a·c is below the bar: one group through b. The Tool never joins.
  const vectors = new Map([
    ["tactic-a", around(1, 1)],
    ["tactic-b", around(0.97, 1)],
    ["tactic-c", around(0.9, 2)],
    ["tool-x", around(1, 1)]
  ]);
  const vb = vectors.get("tactic-b")!;
  const vc = new Float32Array(8);
  // c is 0.95 from b and 0.9 from a.
  vc[0] = 0.9;
  vc[1] = (0.95 - 0.9 * vb[0]!) / vb[1]!;
  vc[2] = Math.sqrt(1 - vc[0] * vc[0] - vc[1] * vc[1]);
  vectors.set("tactic-c", vc);
  const { merges, changed } = await planConceptMerges({ concepts, vectors, thresholds: BARS, existing: [], rejected: [], now: "2026-10-27T12:00:00.000Z", pause: noPause });
  assert.equal(changed, true);
  assert.equal(merges.length, 1);
  const [merge] = merges;
  assert.equal(merge!.into, "tactic-c", "the most entries");
  assert.deepEqual(merge!.merged, ["tactic-b", "tactic-a"]);
  assert.equal(merge!.type, "Tactic");
  assert.equal(merge!.id, conceptMergeId("Tactic", ["tactic-a", "tactic-b", "tactic-c"]));
  assert.ok(Math.abs(merge!.similarity - 0.95) < 1e-3, `lowest joining similarity ${merge!.similarity}`);
  assert.equal(merge!.createdAt, "2026-10-27T12:00:00.000Z");

  assert.equal(keptConcept([c("tactic-z", "Longer name", 2), c("tactic-y", "Short", 2)]).id, "tactic-y");
  assert.equal(keptConcept([c("tactic-z", "Same", 2), c("tactic-y", "Same", 2)]).id, "tactic-y");
});

test("an undone merge is never made again, not even through a third concept; existing merges stay as they are", async () => {
  const concepts = [c("tactic-a", "Warm up TikTok account"), c("tactic-b", "Warm up the TikTok account"), c("tactic-c", "Warm up TikTok accounts"), c("tactic-d", "Card-required trial"), c("tactic-e", "Card-required trials")];
  const same = around(1, 1);
  const vectors = new Map(concepts.map((concept) => [concept.id, concept.id === "tactic-d" || concept.id === "tactic-e" ? around(0.2, 3) : same]));
  const existing: KnowledgeConceptMergeRecord[] = [
    { id: "cm_old", type: "Tactic", into: "tactic-d", merged: ["tactic-e"], similarity: 0.97, createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "cm_gone", type: "Tactic", into: "tactic-x", merged: ["tactic-y"], similarity: 0.95, createdAt: "2026-10-02T00:00:00.000Z" }
  ];
  const { merges, changed } = await planConceptMerges({
    concepts,
    vectors,
    thresholds: BARS,
    existing,
    rejected: [{ id: "cm_undone", type: "Tactic", concepts: ["tactic-a", "tactic-b"], rejectedAt: "t" }],
    now: "now",
    pause: noPause
  });
  assert.equal(changed, true);
  assert.equal(merges[0], existing[0], "an unchanged merge keeps its record");
  assert.equal(merges[1], existing[1], "a merge whose concepts are gone is kept on disk");
  assert.equal(merges.length, 3);
  const added = merges[2]!;
  // a·c merge (or b·c), but never a and b together.
  const group = [added.into, ...added.merged].sort();
  assert.ok(!(group.includes("tactic-a") && group.includes("tactic-b")), `group ${group.join(",")}`);
  assert.equal(group.length, 2);

  // Planning again changes nothing.
  const again = await planConceptMerges({ concepts, vectors, thresholds: BARS, existing: merges, rejected: [{ id: "cm_undone", type: "Tactic", concepts: ["tactic-a", "tactic-b"], rejectedAt: "t" }], now: "later", pause: noPause });
  assert.equal(again.changed, false);
  assert.deepEqual(again.merges, merges);
});

test("a merge that grows becomes a new merge replacing the old one", async () => {
  const concepts = [c("tactic-a", "Warm up TikTok account", 3), c("tactic-b", "Warm up the TikTok account"), c("tactic-c", "Warm up TikTok accounts")];
  const vectors = new Map(concepts.map((concept) => [concept.id, around(1, 1)]));
  const existing: KnowledgeConceptMergeRecord[] = [{ id: "cm_old", type: "Tactic", into: "tactic-a", merged: ["tactic-b"], similarity: 0.93, createdAt: "t0" }];
  const { merges } = await planConceptMerges({ concepts, vectors, thresholds: BARS, existing, rejected: [], now: "t1", pause: noPause });
  assert.deepEqual(
    merges.map((m) => [m.into, m.merged.sort(), m.similarity, m.createdAt]),
    [["tactic-a", ["tactic-b", "tactic-c"], 0.93, "t1"]]
  );
});

// ---------------------------------------------------------------------------
// The service part: plan after a load, apply, list, undo
// ---------------------------------------------------------------------------

const eA = "ke_aaaaaaaaaaaa";
const eB = "ke_bbbbbbbbbbbb";
const A = "kc_aaaaaaaaaa";
const B = "kc_bbbbbbbbbb";
const NODES = [
  node("tactic-warm-up", "Warm up TikTok account", [`${eA}.md`, `${eB}.md`]),
  node("tactic-warm-up-the", "Warm up the TikTok account", [`${eB}.md`]),
  node("tactic-alternatives", "Alternatives pages", [`${eA}.md`]),
  node("tactic-alternative", "The alternatives pages", [`${eA}.md`]),
  node("tactic-annual", "Annual billing discount", [`${eB}.md`])
];

async function coordinator(t: TestContext, options: { file?: unknown; thresholds?: ConceptMergeThresholds | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kg-concept-merges-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "concept-merges.json");
  if (options.file !== undefined) await writeFile(path, typeof options.file === "string" ? options.file : JSON.stringify(options.file));
  const store = new FakeStore();
  store.collection(A, "A");
  store.collection(B, "B");
  store.put(eA, "a", [A], {}, true);
  store.put(eB, "b", [B], {}, true);
  const logger = silentLogger();
  const graph = new KnowledgeGraph({ entries: store, logger });
  const embedder = new FakeEmbedder({ dimensions: 64, groups: [] });
  const source = new FakeEmbedderSource(embedder);
  let clock = Date.parse("2026-10-27T12:00:00.000Z");
  const merges = new KnowledgeConceptMerges({
    graph,
    embedders: source,
    path,
    vectorsDir: join(dir, "index", "concepts"),
    logger,
    now: () => new Date((clock += 1000)),
    thresholds: () => (options.thresholds === undefined ? { merge: 0.85, similar: 0.5 } : options.thresholds),
    pause: noPause
  });
  const changes: number[] = [];
  merges.onChange(() => changes.push(graph.revision()));
  t.after(() => merges.stop());
  return {
    path,
    graph,
    merges,
    embedder,
    source,
    logger,
    changes,
    all: knowledgeScope({ kind: "all" }, [A, B]),
    profile: knowledgeScope({ kind: "collections", ids: [A] }, [A, B]),
    readFile: async () => JSON.parse(await readFile(path, "utf8")) as { merges: KnowledgeConceptMergeRecord[]; rejected: { id: string; concepts: string[] }[] }
  };
}

test("after a load the concepts are embedded and merged: written to the file, applied to the graph, announced", async (t) => {
  const h = await coordinator(t);
  await h.merges.start();
  await loadGraph(h.graph, NODES);
  await h.merges.idle();
  const file = await h.readFile();
  assert.deepEqual(
    file.merges.map((m) => [m.into, m.merged]).sort(),
    [
      ["tactic-alternatives", ["tactic-alternative"]],
      ["tactic-warm-up", ["tactic-warm-up-the"]]
    ]
  );
  assert.equal(h.merges.count(), 2);
  assert.equal(h.changes.length, 1, "one change for the plan");
  assert.equal(h.graph.hasConcept("tactic-warm-up-the"), false);
  assert.ok(h.embedder.calls >= 1);
  // The kept concept lists what was folded into it, and similar (unmerged) concepts.
  const view = h.graph.concept("tactic-warm-up", h.all)!;
  assert.deepEqual(view.mergedFrom.map((c) => c.id), ["tactic-warm-up-the"]);
  assert.ok(view.similarConcepts.every((s) => s.concept.id !== "tactic-warm-up-the" && s.similarity >= 0.5));
  // A reload re-applies the merges at once, before any vector is recomputed.
  const calls = h.embedder.calls;
  await loadGraph(h.graph, NODES);
  assert.equal(h.graph.hasConcept("tactic-warm-up-the"), false);
  await h.merges.idle();
  assert.equal(h.embedder.calls, calls, "cached vectors: nothing embedded again");
  assert.equal(h.changes.length, 1);
});

test("list is scoped; undo takes the merge apart, records it as rejected, and it is never made again", async (t) => {
  const h = await coordinator(t);
  await h.merges.start();
  await loadGraph(h.graph, NODES);
  await h.merges.idle();
  assert.equal(h.merges.list(h.all).length, 2);
  // The profile sees eA only: the warm-up merge folded a concept only eB backs.
  assert.deepEqual(
    h.merges.list(h.profile).map((m) => m.into.id),
    ["tactic-alternatives"]
  );
  const warmUp = h.merges.list(h.all).find((m) => m.into.id === "tactic-warm-up")!;
  assert.equal(await h.merges.undo(warmUp.id, h.profile), false, "not visible to the profile");
  assert.equal(await h.merges.undo("cm_nope", h.all), false);
  const before = h.graph.revision();
  assert.equal(await h.merges.undo(warmUp.id, h.all), true);
  assert.ok(h.graph.revision() > before);
  assert.equal(h.graph.hasConcept("tactic-warm-up-the"), true);
  assert.equal(h.merges.count(), 1);
  const file = await h.readFile();
  assert.deepEqual(
    file.rejected.map((r) => [r.id, r.concepts]),
    [[warmUp.id, ["tactic-warm-up", "tactic-warm-up-the"]]]
  );
  // Another load and plan: still apart.
  await loadGraph(h.graph, [...NODES, node("tactic-annual-2", "The annual billing discount", [`${eB}.md`])]);
  await h.merges.idle();
  assert.equal(h.graph.hasConcept("tactic-warm-up-the"), true);
  assert.equal(h.graph.hasConcept("tactic-annual-2"), false, "new duplicates still merge");
});

test("merges from the file apply before the first load; stale ones stay on disk; no calibrated model, no new merges", async (t) => {
  const record = { id: "cm_file", type: "tactic", into: "tactic-annual", merged: ["tactic-alternatives"], similarity: 0.95, createdAt: "t", extra: 1 };
  const stale = { id: "cm_stale", type: "tactic", into: "tactic-gone", merged: ["tactic-alternative"], similarity: 0.95, createdAt: "t" };
  const h = await coordinator(t, { file: { version: 1, merges: [record, stale], rejected: [], future: true }, thresholds: null });
  await h.merges.start();
  await loadGraph(h.graph, NODES);
  await h.merges.idle();
  assert.deepEqual(
    h.graph.conceptMerges().map((m) => m.id),
    ["cm_file"]
  );
  assert.equal(h.graph.hasConcept("tactic-warm-up-the"), true, "no thresholds for the model: nothing new is merged");
  assert.deepEqual(h.graph.concept("tactic-annual", h.all)!.similarConcepts, []);
});

test("a newer build's file is left alone: nothing applies, nothing is written, undo refuses", async (t) => {
  const raw = JSON.stringify({ version: 2, merges: [{ id: "cm_x", type: "tactic", into: "tactic-annual", merged: ["tactic-alternatives"] }] });
  const h = await coordinator(t, { file: raw });
  await h.merges.start();
  await loadGraph(h.graph, NODES);
  await h.merges.idle();
  assert.equal(h.merges.count(), 0);
  assert.equal(await readFile(h.path, "utf8"), raw);
  assert.ok(h.logger.lines.some((line) => line.includes("newer version")));
});

test("an unreadable file is moved aside and merging starts afresh", async (t) => {
  const h = await coordinator(t, { file: "{not json" });
  await h.merges.start();
  await loadGraph(h.graph, NODES);
  await h.merges.idle();
  assert.equal(h.merges.count(), 2);
  assert.ok(h.logger.lines.some((line) => line.includes("moved to")));
});
