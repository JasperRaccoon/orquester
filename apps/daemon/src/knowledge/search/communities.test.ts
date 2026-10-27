import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { type WeightedEdge, communities } from "./communities.ts";

/** Every pair of `nodes`, at `weight`. */
function clique(nodes: readonly number[], weight: number): WeightedEdge[] {
  const out: WeightedEdge[] = [];
  for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) out.push({ a: nodes[i]!, b: nodes[j]!, weight });
  return out;
}

const groupsOf = (labels: Int32Array): number[][] => {
  const groups = new Map<number, number[]>();
  labels.forEach((label, node) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(node);
  });
  return [...groups.values()];
};

test("two dense groups joined by a weak link are two communities, numbered by their first node", async () => {
  const edges = [...clique([0, 2, 4, 6], 1), ...clique([1, 3, 5, 7], 0.8), { a: 6, b: 7, weight: 0.1 }];
  assert.deepEqual([...(await communities(8, edges))], [0, 1, 0, 1, 0, 1, 0, 1]);
});

test("a ring of six cliques is six communities, not one", async () => {
  const edges: WeightedEdge[] = [];
  for (let c = 0; c < 6; c += 1) {
    edges.push(...clique([c * 5, c * 5 + 1, c * 5 + 2, c * 5 + 3, c * 5 + 4], 0.5));
    edges.push({ a: c * 5, b: ((c + 1) % 6) * 5 + 1, weight: 0.5 });
  }
  const groups = groupsOf(await communities(30, edges));
  assert.deepEqual(groups, [0, 1, 2, 3, 4, 5].map((c) => [c * 5, c * 5 + 1, c * 5 + 2, c * 5 + 3, c * 5 + 4]));
});

test("a lone tight group stays whole", async () => {
  assert.deepEqual([...(await communities(3, clique([0, 1, 2], 0.9)))], [0, 0, 0]);
  const uneven = [
    { a: 0, b: 1, weight: 0.86 },
    { a: 0, b: 2, weight: 0.78 },
    { a: 1, b: 2, weight: 0.67 }
  ];
  assert.deepEqual([...(await communities(3, uneven))], [0, 0, 0]);
});

test("nodes without a positive edge are alone; no nodes, no communities", async () => {
  const edges = [...clique([1, 2, 3], 1), { a: 0, b: 4, weight: 0 }, { a: 4, b: 5, weight: -1 }, { a: 5, b: 5, weight: 1 }];
  assert.deepEqual([...(await communities(6, edges))], [0, 1, 1, 1, 2, 3]);
  assert.deepEqual([...(await communities(3, []))], [0, 1, 2]);
  assert.deepEqual([...(await communities(0, []))], []);
});

test("deterministic: the same graph, its edges in any order, gives the same communities", async () => {
  let seed = 11;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  // 60 nodes in 6 noisy groups (node i in group i % 6), plus weak links across.
  const edges: WeightedEdge[] = [];
  for (let a = 0; a < 60; a += 1) {
    for (let b = a + 1; b < 60; b += 1) {
      const same = a % 6 === b % 6;
      if (random() < (same ? 0.6 : 0.05)) edges.push({ a, b, weight: same ? 0.3 + random() * 0.5 : random() * 0.2 });
    }
  }
  const first = await communities(60, edges);
  // The same edges shuffled, about half of them with their ends swapped.
  const shuffled = edges
    .map((edge) => ({ edge, at: random() }))
    .sort((x, y) => x.at - y.at)
    .map(({ edge }) => (random() < 0.5 ? edge : { a: edge.b, b: edge.a, weight: edge.weight }));
  assert.deepEqual(await communities(60, shuffled), first);
  assert.deepEqual(await communities(60, edges), first);
  assert.deepEqual(groupsOf(first), [0, 1, 2, 3, 4, 5].map((g) => Array.from({ length: 10 }, (_, i) => g + i * 6)));
});

test("awaits the pause between passes", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let finished = false;
  const result = communities(8, [...clique([0, 1, 2, 3], 1), ...clique([4, 5, 6, 7], 1), { a: 3, b: 4, weight: 0.1 }], async () => {
    enter();
    await paused;
  }).then((labels) => { finished = true; return labels; });
  await entered;
  await setImmediate();
  assert.equal(finished, false, "clustering waits for the caller's pause");
  release();
  assert.deepEqual([...(await result)], [0, 0, 0, 0, 1, 1, 1, 1]);
});
