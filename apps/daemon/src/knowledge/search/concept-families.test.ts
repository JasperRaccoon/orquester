import assert from "node:assert/strict";
import test from "node:test";
import { EMBEDDING_MODEL_ID } from "../install/pins.ts";
import {
  E5_SMALL_FAMILY_PARAMS,
  KnowledgeConceptFamilies,
  conceptFamilyId,
  familiesOf,
  familyConceptsOf,
  familyVocabularyOf,
  familyWords,
  planConceptFamilies,
  type FamilyConcept
} from "./concept-families.ts";
import type { GraphConcept } from "./graph.ts";

const DIMS = 64;

/** A unit vector around `base` (an axis per question), `spread` along its own axis: same-base pairs score 1/(1+spread²). */
function around(base: number, own: number, similarity: number): Float32Array {
  const t = Math.sqrt(1 / similarity - 1);
  const v = new Float32Array(DIMS);
  v[base] = 1;
  v[own] = t;
  const norm = Math.hypot(1, t);
  for (let i = 0; i < DIMS; i += 1) v[i]! /= norm;
  return v;
}

let axis = 10;
function concept(name: string, base: number, options: { type?: string; entries?: string[]; similarity?: number; id?: string } = {}): { concept: FamilyConcept; vector: Float32Array } {
  const id = options.id ?? `tactic-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return {
    concept: { id, type: options.type ?? "Tactic", name, names: [name], entryIds: options.entries ?? [`ke_${id.slice(-12)}`], vectorIds: [id] },
    vector: around(base, axis++, options.similarity ?? 0.9)
  };
}

/** No word is common: every shared topic word links. */
const RARE = familyVocabularyOf(new Map(), 3000);

function families(items: { concept: FamilyConcept; vector: Float32Array }[], vocabulary = RARE) {
  return familiesOf({ concepts: items.map((i) => i.concept), vectors: new Map(items.map((i) => [i.concept.id, i.vector])), vocabulary });
}
const names = (items: { concept: FamilyConcept }[], result: ReturnType<typeof families>) => {
  const byId = new Map(items.map((i) => [i.concept.id, i.concept.name]));
  return result.map((family) => family.concepts.map((id) => byId.get(id)!).sort());
};

test("topic words: no glue, generic words, numbers or roman numerals; stems and synonyms", () => {
  assert.deepEqual([...familyWords("Warm up the account for 48 hours before posting")].sort(), ["account", "hour", "post", "warm"]);
  assert.deepEqual([...familyWords("3-5 days of warming up")].sort(), ["day", "warm"]);
  assert.deepEqual([...familyWords("TikTok account warmup")].sort(), ["account", "tiktok", "warm"]);
  // "erased" and "factory reset" name one thing; an iPhone is a device.
  assert.deepEqual([...familyWords("Use an erased iPhone")].sort(), ["devic", "reset"]);
  assert.deepEqual([...familyWords("Factory reset the iPhone")].sort(), ["devic", "factory", "reset"]);
  assert.deepEqual([...familyWords("Remove entitlements you don't actively use")], ["entitlement"]);
  assert.deepEqual([...familyWords("Guideline 2.4.5(ii)")], ["guidelin"]);
  assert.deepEqual([...familyWords("Always pick US/EU servers plus one")].sort(), ["eu", "server", "us"]);
});

test("close concepts sharing a topic word form a family; the same closeness with only a generic word does not", () => {
  const items = [concept("Warm up the account for 48 hours", 0), concept("Warm up each account for 3 days", 0), concept("3-5 days of warming up", 0)];
  assert.deepEqual(names(items, families(items)), [["3-5 days of warming up", "Warm up each account for 3 days", "Warm up the account for 48 hours"]]);
  // "Remove entitlements you don't actively use" ~ "Use an erased iPhone" at 0.93: only "use" in common.
  const lookAlikes = [concept("Remove entitlements you don't actively use", 1, { similarity: 0.93 }), concept("Use an erased iPhone", 1, { similarity: 0.93 })];
  assert.deepEqual(families(lookAlikes), []);
});

test("below the bar, no family", () => {
  const items = [concept("No SIM in the phone", 2, { similarity: 0.86 }), concept("Never keep a foreign SIM in the phone", 2, { similarity: 0.86 })];
  assert.deepEqual(families(items), []);
  const close = [concept("No SIM in the phone", 3, { similarity: 0.88 }), concept("Never keep a foreign SIM", 3, { similarity: 0.88 })];
  assert.equal(families(close).length, 1);
});

test("common words link only two at a time, with nothing else in the shorter name; frequent ones never", () => {
  const vocabulary = familyVocabularyOf(new Map([["account", 79], ["devic", 101], ["tiktok", 63], ["guidelin", 143], ["lock", 2], ["chargeback", 2]]), 2979);
  const device = [concept("One device per account", 4), concept("2–3 accounts per device", 4), concept("5 TikTok accounts on each iPhone", 4)];
  assert.deepEqual(names(device, families(device, vocabulary)), [["2–3 accounts per device", "5 TikTok accounts on each iPhone", "One device per account"]]);
  // One common word ("account"), however close: no link.
  const lone = [concept("One device per account", 5, { similarity: 0.95 }), concept("Locking accounts after chargebacks", 5, { similarity: 0.95 })];
  assert.deepEqual(families(lone, vocabulary), []);
  // Two common words, but the shorter name says more ("lock", "chargeback"): no link.
  const more = [concept("TikTok account device", 6, { similarity: 0.95 }), concept("Lock TikTok account chargeback", 6, { similarity: 0.95 })];
  assert.deepEqual(families(more, vocabulary), []);
  const guidelines = [concept("Guideline 1.4", 7, { type: "Guideline", similarity: 0.97 }), concept("Guideline 2.2", 7, { type: "Guideline", similarity: 0.97 })];
  assert.deepEqual(families(guidelines, vocabulary), []);
});

test("a family needs two entries; only claim types; never across types", () => {
  const one = [concept("No SIM in the phone", 8, { entries: ["ke_one"] }), concept("Never keep a foreign SIM", 8, { entries: ["ke_one"] })];
  assert.deepEqual(families(one), []);
  const persons = [concept("Alex warm", 9, { type: "Person" }), concept("Alex warm up", 9, { type: "Person" })];
  assert.deepEqual(families(persons), []);
  const mixed = [concept("Scamalytics", 10, { type: "Tool" }), concept("Check a Scamalytics score", 10)];
  assert.deepEqual(families(mixed), []);
  for (const type of ["Tactic", "Tool", "Metric", "Result", "Guideline"]) {
    const pair = [concept(`Scamalytics ${type} a`, 11, { type, id: `${type}-a` }), concept(`Scamalytics ${type} b`, 11, { type, id: `${type}-b` })];
    assert.equal(families(pair).length, 1, type);
  }
});

test("average linkage: one shared word does not chain two questions together", () => {
  // A–B share "sim", B–C share "vpn", A–C nothing: B joins one side only.
  const items = [concept("No SIM in the phone", 12), concept("Remove the SIM card and stay on VPN", 12), concept("Keep the VPN active", 12)];
  const result = names(items, families(items));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.length, 2);
  // A group joins another only when most pairs across them link.
  const two = [concept("Warm up for 48 hours", 13), concept("Warm up for 3 days", 13), concept("No SIM in the phone", 13), concept("Never keep a foreign SIM", 13)];
  assert.deepEqual(names(two, families(two)).sort(), [
    ["Never keep a foreign SIM", "No SIM in the phone"],
    ["Warm up for 3 days", "Warm up for 48 hours"]
  ]);
});

test("a family has at most maxSize concepts", () => {
  const items = Array.from({ length: E5_SMALL_FAMILY_PARAMS.maxSize + 3 }, (_, i) => concept(`Warm up variant ${String.fromCharCode(97 + i)}`, 14, { similarity: 0.95 }));
  const result = families(items);
  assert.ok(result.every((family) => family.concepts.length <= E5_SMALL_FAMILY_PARAMS.maxSize));
  assert.equal(result[0]!.concepts.length, E5_SMALL_FAMILY_PARAMS.maxSize);
});

test("deterministic: the same families whatever the input order; the id follows the first member", async () => {
  const items = [concept("Warm up for 48 hours", 15), concept("Warm up for 3 days", 15), concept("No SIM in the phone", 16), concept("Never keep a foreign SIM", 16), concept("Warm up for 5-7 days", 15)];
  const forward = families(items);
  const backward = families([...items].reverse());
  assert.deepEqual(backward, forward);
  const planned = await planConceptFamilies(
    { concepts: items.map((i) => i.concept), vectors: new Map(items.map((i) => [i.concept.id, i.vector])), vocabulary: RARE },
    async () => undefined
  );
  assert.deepEqual(planned, forward);
  for (const family of forward) assert.equal(family.id, conceptFamilyId(family.type, family.concepts));
  assert.equal(conceptFamilyId("Tactic", ["b", "a", "c"]), conceptFamilyId("Tactic", ["a", "z"]));
  // Members by entries, most first; every entry listed once.
  const warm = forward.find((family) => family.concepts.length === 3)!;
  assert.equal(warm.entryIds.length, 3);
});

function graphConcept(id: string, name: string, entryIds: string[], merge?: { id: string; name: string }[]): GraphConcept {
  return {
    id,
    type: "Tactic",
    name,
    confidence: 1,
    description: null,
    aliases: [],
    attributes: {},
    entryIds,
    ...(merge ? { merge: { id, sources: merge.map((source) => ({ ...source, type: "Tactic", confidence: 1, description: null, aliases: [], attributes: {}, entryIds })) } } : {})
  };
}

test("a merged concept reads its sources' names and vectors", () => {
  const read = familyConceptsOf([graphConcept("tactic-a", "Kept name", ["ke_a"], [{ id: "tactic-a", name: "Kept name" }, { id: "tactic-b", name: "Warm up for 3 days" }])]);
  assert.deepEqual(read[0]!.names, ["Kept name", "Warm up for 3 days"]);
  assert.deepEqual(read[0]!.vectorIds, ["tactic-a", "tactic-b"]);
  const vectors = new Map([
    ["tactic-a", around(20, 21, 0.5)],
    ["tactic-b", around(22, 23, 0.9)],
    ["tactic-c", around(22, 24, 0.9)]
  ]);
  const result = familiesOf({ concepts: [...read, ...familyConceptsOf([graphConcept("tactic-c", "Warm up for 48 hours", ["ke_c"])])], vectors, vocabulary: RARE });
  assert.deepEqual(result.map((family) => [...family.concepts].sort()), [["tactic-a", "tactic-c"]]);
});

test("the live families: computed on update, by the vectors' model, answered for merged ids, recomputed when the graph moves", async () => {
  const concepts = [graphConcept("tactic-warm-48", "Warm up for 48 hours", ["ke_1"]), graphConcept("tactic-warm-3", "Warm up for 3 days", ["ke_2"]), graphConcept("tactic-sim", "No SIM", ["ke_3"])];
  const vectors = new Map([
    ["tactic-warm-48", around(30, 31, 0.9)],
    ["tactic-warm-3", around(30, 32, 0.9)],
    ["tactic-sim", around(33, 34, 0.9)]
  ]);
  let modelId = EMBEDDING_MODEL_ID;
  let revision = 1;
  let changes = 0;
  const live = new KnowledgeConceptFamilies({
    concepts: () => concepts,
    canonical: (id) => (id === "tactic-folded" ? "tactic-warm-3" : id),
    revision: () => revision,
    vectors: () => ({ modelId, vectors }),
    pause: async () => undefined
  });
  live.onChange(() => (changes += 1));
  assert.deepEqual(live.families(), []);
  assert.equal(live.familyOf("tactic-warm-48"), null);
  live.update();
  await live.idle();
  assert.equal(changes, 1);
  assert.deepEqual([...live.familyOf("tactic-warm-48")!].sort(), ["tactic-warm-3", "tactic-warm-48"]);
  assert.deepEqual([...live.familyOf("tactic-folded")!].sort(), ["tactic-warm-3", "tactic-warm-48"]);
  assert.equal(live.familyOf("tactic-sim"), null);
  assert.equal(live.revision(), 1);
  // The same families again: no change announced.
  live.update();
  await live.idle();
  assert.equal(changes, 1);
  // The graph moved (a merge undone): a read computes them again.
  concepts.push(graphConcept("tactic-warm-5", "Warm up for 5-7 days", ["ke_4"]));
  vectors.set("tactic-warm-5", around(30, 35, 0.9));
  revision = 2;
  live.familyOf("tactic-warm-48");
  await live.idle();
  assert.equal(live.familyOf("tactic-warm-48")!.length, 3);
  assert.equal(changes, 2);
  // Another model's vectors: no families.
  modelId = "some/other-model";
  live.update();
  await live.idle();
  assert.deepEqual(live.families(), []);
  await live.stop();
});
