import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeConceptRef } from "@orquester/api";
import { cpu, cpuFloor, workClock } from "../search/test-fakes.ts";
import { FakeVectorIndex } from "../search/fake-vector-index.ts";
import type { KnowledgeLinkGraphView } from "./context.ts";
import { pairCheckCandidates } from "./pair-checks.ts";

// Pair-check candidates over ~3,000 linked entries at the real model's 384 dimensions: every pair
// is compared once, but what is kept stays bounded (each entry's nearest few, the close pairs), and
// the event loop keeps turning when a deterministic clock says a work slice is due.

const ENTRIES = 3_000;
const DIMS = 384;
const CLUSTER = 40;
const TACTICS = 12;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("pair-check candidates at 3,000 entries: bounded memory, and the event loop keeps turning", async (t) => {
  const random = prng(11);
  const index = new FakeVectorIndex(); // good = 0.5
  const concepts = new Map<string, KnowledgeConceptRef[]>();
  const centres = Array.from({ length: Math.ceil(ENTRIES / CLUSTER) }, () => Array.from({ length: DIMS }, () => random() - 0.5));
  const ids: string[] = [];
  for (let i = 0; i < ENTRIES; i += 1) {
    const id = `ke_${i.toString(36).padStart(6, "0")}`;
    ids.push(id);
    const cluster = Math.floor(i / CLUSTER);
    index.set(id, centres[cluster]!.map((x) => x + (random() - 0.5) * 0.3));
    // Claims of one cluster share words, some turned around: every close pair runs the negation test.
    concepts.set(
      id,
      Array.from({ length: TACTICS }, (_, t) => ({
        id: `tactic-${i}-${t}`,
        type: "Tactic",
        name: `${t % 3 === 0 ? "Never post" : "Post"} topic ${cluster} angle ${t} with proxy ${i % 7}`
      }))
    );
  }
  const view: KnowledgeLinkGraphView = { vectors: () => index, conceptsOf: (id) => concepts.get(id) ?? [], contradicting: () => [] };
  // Entry vectors are computed once by the index, before the measurement.
  const rows = ids.map((id) => index.entryVector(id)!);
  const sliceBudget = cpuFloor(() => {
    let sum = 0;
    for (const row of rows) for (let d = 0; d < DIMS; d += 1) sum += rows[0]![d]! * row[d]!;
    return sum;
  }) * 20;
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  workClock(t, 1_024);
  let maxGap = 0;
  let turns = 0;
  let last = cpu();
  let running = true;
  const tick = (): void => {
    const now = cpu();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    turns += 1;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const candidates = await pairCheckCandidates({ ids, view, hashOf: (id) => `h-${id}`, isChecked: () => false, limit: 30 });
  running = false;
  peak = Math.max(peak, process.memoryUsage().heapUsed);

  assert.equal(candidates.length, 30);
  assert.ok(candidates.every((c) => c.reason === "negation"), "close pairs whose claims turn each other around come first");
  assert.ok(turns > 20, `the event loop turned ${turns} times`);
  assert.ok(maxGap < sliceBudget, `longest slice ${maxGap.toFixed(1)} CPU ms exceeds ${sliceBudget.toFixed(1)} CPU ms (20 vector scans)`);
  // Every pair both ways (the old neighbour lists) would be 9 million objects, several hundred MB.
  const grown = (peak - baseline) / 2 ** 20;
  assert.ok(grown < 150, `the heap grew by ${grown.toFixed(0)} MB`);
});
