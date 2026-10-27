import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeVectorIndex, around, axis } from "./fake-vector-index.ts";
import { findLinkGaps, linkGapConceptKey } from "./gaps.ts";

const DIMS = 8;

function setup() {
  const index = new FakeVectorIndex();
  index.set("ke_a", axis(DIMS, 0));
  index.set("ke_b", around(DIMS, 0, 1, 0.95));
  index.set("ke_c", around(DIMS, 0, 2, 0.9));
  index.set("ke_d", axis(DIMS, 3));
  index.set("ke_e", around(DIMS, 0, 4, 0.97));
  const concepts: Record<string, string[]> = {
    ke_a: ["tactic-x"],
    ke_b: ["tool-y"], // close to a, shares nothing: a gap
    ke_c: ["tactic-x"], // close to a, shares tactic-x: no gap
    ke_d: ["tool-y"], // far from everything
    ke_e: [] // not linked yet: never a gap
  };
  return { index, conceptsOf: (id: string) => concepts[id] ?? [] };
}

test("pairs close in meaning that share no concept, closest first; unlinked and far entries never count", async () => {
  const { index, conceptsOf } = setup();
  const gaps = await findLinkGaps({ ids: ["ke_a", "ke_b", "ke_c", "ke_d", "ke_e"], index, conceptsOf, minimum: 0.85, limit: 10 });
  assert.deepEqual(
    gaps.map((g) => [g.a, g.b]),
    [
      ["ke_a", "ke_b"],
      ["ke_b", "ke_c"]
    ]
  );
  assert.ok(gaps[0]!.similarity >= gaps[1]!.similarity);
  assert.ok(gaps.every((g) => g.a < g.b));
});

test("exclude leaves pairs out before the limit applies", async () => {
  const { index, conceptsOf } = setup();
  const ids = ["ke_a", "ke_b", "ke_c", "ke_d", "ke_e"];
  const seen: string[] = [];
  const next = await findLinkGaps({
    ids,
    index,
    conceptsOf,
    minimum: 0.85,
    limit: 1,
    exclude: (a, b) => {
      seen.push(`${a} ${b}`);
      return a === "ke_a" && b === "ke_b";
    }
  });
  assert.deepEqual(
    next.map((g) => [g.a, g.b]),
    [["ke_b", "ke_c"]],
    "the closest pair is excluded, so the next one fills the limit"
  );
  assert.ok(seen.every((key) => key.split(" ")[0]! < key.split(" ")[1]!), "asked with sorted ids");
});

test("scoped ids, the limit and the threshold are honoured", async () => {
  const { index, conceptsOf } = setup();
  assert.deepEqual(await findLinkGaps({ ids: ["ke_a", "ke_c", "ke_d"], index, conceptsOf, minimum: 0.85, limit: 10 }), []);
  assert.equal((await findLinkGaps({ ids: ["ke_a", "ke_b", "ke_c"], index, conceptsOf, minimum: 0.85, limit: 1 })).length, 1);
  assert.deepEqual(await findLinkGaps({ ids: ["ke_a", "ke_b", "ke_c"], index, conceptsOf, minimum: 0.999, limit: 10 }), []);
});

test("a hub close to everything is no gap with each of its neighbours; two entries as close as their usual neighbours are", async () => {
  const dims = 32;
  const vector = (parts: [number, number][]): Float32Array => {
    const out = new Float32Array(dims);
    for (const [dim, value] of parts) out[dim] = value;
    const norm = Math.hypot(...out);
    return out.map((value) => value / norm);
  };
  const index = new FakeVectorIndex();
  const concepts: Record<string, string[]> = {};
  // Ten entries on one topic (0.97 apart), linked to it; a long guide near all of them (0.89) linked
  // to something else; two short posts close to each other (0.92) and to nothing else.
  for (let i = 1; i <= 10; i += 1) {
    index.set(`ke_g${i}`, vector([[0, 1], [i, 0.18]]));
    concepts[`ke_g${i}`] = ["topic"];
  }
  index.set("ke_hub", vector([[0, 1], [20, 0.48]]));
  concepts.ke_hub = ["guide"];
  index.set("ke_p", vector([[25, 1], [26, 0.3]]));
  index.set("ke_q", vector([[25, 1], [27, 0.3]]));
  concepts.ke_p = ["sim swap"];
  concepts.ke_q = ["esim"];
  const gaps = await findLinkGaps({ ids: Object.keys(concepts), index, conceptsOf: (id) => concepts[id] ?? [], minimum: 0.85, limit: 50 });
  assert.deepEqual(gaps.map((g) => [g.a, g.b]), [["ke_p", "ke_q"]]);
});

test("link gaps compare concepts by name: one thing extracted under two types links its entries", () => {
  assert.equal(linkGapConceptKey({ name: "App  Store" }), linkGapConceptKey({ name: "app store" }));
  assert.equal(linkGapConceptKey({ name: "Café" }), linkGapConceptKey({ name: "cafe" }));
  assert.notEqual(linkGapConceptKey({ name: "App Store" }), linkGapConceptKey({ name: "Play Store" }));
});
