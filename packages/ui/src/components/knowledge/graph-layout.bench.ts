/**
 * Measure warm-start seeding on the real graph path, including a graph grown
 * by a chain of concepts (the worst case for scanning pending nodes by round).
 * Run from packages/ui:
 * TSX_DISABLE_CACHE=1 node --import tsx src/components/knowledge/graph-layout.bench.ts [baseline-revision]
 * A revision loads that module beside this one and checks exact position and
 * property ordering equivalence before measuring both implementations.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { seedPositions, type Positions } from "./graph-layout";

const revision = process.argv[2];
let baseline: typeof seedPositions | undefined;
if (revision) {
  const file = new URL(`.graph-layout-baseline-${process.pid}.ts`, import.meta.url);
  writeFileSync(file, execFileSync("git", ["show", `${revision}:packages/ui/src/components/knowledge/graph-layout.ts`]));
  try {
    baseline = (await import(file.href)).seedPositions as typeof seedPositions;
  } finally {
    unlinkSync(file);
  }
}

const nodes = Array.from({ length: 2_000 }, (_, i) => ({ id: `n${i}`, size: 10 + (i % 6) * 4 }));
const placed: Positions = Object.fromEntries(nodes.slice(0, 1_000).map((n, i) => [n.id, { x: i % 40, y: Math.floor(i / 40) }]));
const edges = {
  chain: nodes.slice(1_000).map((n, i) => ({ source: nodes[i + 999]!.id, target: n.id })),
  star: nodes.slice(1_000).map((n) => ({ source: "n0", target: n.id })),
  disconnected: [] as { source: string; target: string }[]
};
const rows: unknown[] = [];
for (const [shape, links] of Object.entries(edges)) {
  const expected = seedPositions(nodes, links, placed);
  if (baseline) assert.equal(JSON.stringify(baseline(nodes, links, placed)), JSON.stringify(expected), `${shape}: exact coordinates and property order`);
  const variants = baseline ? [[revision, baseline], ["working-tree", seedPositions]] as const : [["working-tree", seedPositions]] as const;
  for (const [implementation, seed] of variants) {
    const samples: number[] = [];
    for (let round = 0; round < 9; round += 1) {
      const start = performance.now();
      const positions = seed(nodes, links, placed);
      const elapsed = performance.now() - start;
      assert.equal(JSON.stringify(positions), JSON.stringify(expected));
      if (round > 1) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    rows.push({ shape, implementation, nodes: nodes.length, seeded: Object.keys(placed).length, edges: links.length, medianMs: +samples[3]!.toFixed(3), samplesMs: samples.map((n) => +n.toFixed(3)) });
  }
}
console.log(JSON.stringify(rows, null, 2));
