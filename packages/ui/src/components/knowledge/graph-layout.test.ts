import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LAYOUT_GAP, Layouts, computeLayout, seedPositions, warmStart, type LayoutRequest, type LayoutResponse, type LayoutWorkerLike } from "./graph-layout.ts";

describe("the graph layout", () => {
  it("places every concept at finite points, ignoring edges it cannot draw", () => {
    const positions = computeLayout({
      nodes: [
        { id: "a", size: 20 },
        { id: "b", size: 10 },
        { id: "c", size: 10 }
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "a" },
        { source: "a", target: "missing" }
      ]
    });
    assert.deepEqual(Object.keys(positions).sort(), ["a", "b", "c"]);
    for (const { x, y } of Object.values(positions)) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  });

  it("keeps every two concepts apart, the same way each time, even round a crowded hub", () => {
    // A hub with many leaves, a chain off it, and unlinked concepts: the shapes that used to pile up.
    const nodes = [{ id: "hub", size: 44 }];
    const edges: { source: string; target: string }[] = [];
    for (let i = 0; i < 120; i += 1) {
      nodes.push({ id: `leaf${i}`, size: 10 + (i % 4) * 4 });
      edges.push({ source: "hub", target: `leaf${i}` });
    }
    for (let i = 0; i < 20; i += 1) {
      nodes.push({ id: `chain${i}`, size: 12 });
      edges.push({ source: i === 0 ? "leaf0" : `chain${i - 1}`, target: `chain${i}` });
    }
    for (let i = 0; i < 40; i += 1) nodes.push({ id: `lone${i}`, size: 10 });
    const positions = computeLayout({ nodes, edges });
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = positions[nodes[i]!.id]!;
        const b = positions[nodes[j]!.id]!;
        const clear = Math.hypot(a.x - b.x, a.y - b.y) - (nodes[i]!.size + nodes[j]!.size) / 2;
        assert.ok(clear >= LAYOUT_GAP - 0.5, `${nodes[i]!.id} and ${nodes[j]!.id} are ${clear.toFixed(1)} apart`);
      }
    }
    assert.deepEqual(computeLayout({ nodes, edges }), positions, "the same graph gets the same picture");
  });

  it("starts a grown graph from where it was, so the picture stays put", () => {
    const nodes: { id: string; size: number }[] = [];
    const edges: { source: string; target: string }[] = [];
    for (let c = 0; c < 6; c += 1) {
      nodes.push({ id: `hub${c}`, size: 30 });
      if (c > 0) edges.push({ source: `hub${c - 1}`, target: `hub${c}` });
      for (let i = 0; i < 25; i += 1) {
        nodes.push({ id: `n${c}-${i}`, size: 10 });
        edges.push({ source: `hub${c}`, target: `n${c}-${i}` });
      }
    }
    const before = computeLayout({ nodes, edges });
    // An entry gets linked: a few new concepts on two hubs, ahead of the rest in the graph's order.
    const grown = { nodes: [...nodes], edges: [...edges] };
    for (let i = 0; i < 5; i += 1) {
      grown.nodes.unshift({ id: `new${i}`, size: 10 });
      grown.edges.push({ source: `hub${i % 2}`, target: `new${i}` });
    }
    const initial = warmStart(grown.nodes.map((n) => n.id), new Map(Object.entries(before)));
    assert.ok(initial, "a grown graph is a warm start");
    const warm = computeLayout({ ...grown, initial });
    const cold = computeLayout(grown);
    const drift = (after: Record<string, { x: number; y: number }>) =>
      nodes.reduce((sum, n) => sum + Math.hypot(after[n.id]!.x - before[n.id]!.x, after[n.id]!.y - before[n.id]!.y), 0) / nodes.length;
    assert.ok(drift(warm) < drift(cold) / 4, `warm drift ${drift(warm).toFixed(1)} vs cold ${drift(cold).toFixed(1)}`);
    for (let i = 0; i < grown.nodes.length; i += 1) {
      for (let j = i + 1; j < grown.nodes.length; j += 1) {
        const a = warm[grown.nodes[i]!.id]!;
        const b = warm[grown.nodes[j]!.id]!;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= (grown.nodes[i]!.size + grown.nodes[j]!.size) / 2, "no overlaps after a warm start");
      }
    }
  });
});

describe("the warm start", () => {
  const placed = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 0 }],
    ["c", { x: 0, y: 100 }],
    ["d", { x: 100, y: 100 }]
  ]);

  it("applies to the same graph grown or trimmed a little, not to another graph", () => {
    assert.deepEqual(warmStart(["a", "b", "c", "d", "e"], placed), Object.fromEntries(placed));
    assert.deepEqual(Object.keys(warmStart(["a", "b", "c"], placed) ?? {}), ["a", "b", "c"]);
    assert.equal(warmStart(["a"], placed), null, "a filter down to a corner of the graph is laid out afresh");
    assert.equal(warmStart(["a", "b", "x", "y", "z"], placed), null, "mostly new concepts are laid out afresh");
    assert.equal(warmStart(["a"], new Map()), null);
  });

  it("seeds new concepts beside their placed neighbours, and unlinked ones on the halo", () => {
    const seeds = seedPositions(
      [
        { id: "a", size: 10 },
        { id: "b", size: 10 },
        { id: "near-a", size: 10 },
        { id: "next", size: 10 },
        { id: "lone", size: 10 }
      ],
      [
        { source: "a", target: "near-a" },
        { source: "near-a", target: "next" }
      ],
      { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
    );
    assert.deepEqual(seeds.a, { x: 0, y: 0 });
    assert.deepEqual(seeds.b, { x: 100, y: 0 });
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    assert.ok(dist(seeds["near-a"]!, seeds.a) < 40, "beside its neighbour");
    assert.ok(dist(seeds.next!, seeds["near-a"]!) < 40, "a chain of new concepts follows the placed part");
    assert.ok(dist(seeds.lone!, { x: 50, y: 0 }) > 50, "unlinked: outside the placed part");
  });
});

/** A worker that answers only when told to. */
class FakeWorker implements LayoutWorkerLike {
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: LayoutRequest[] = [];
  terminated = false;
  postMessage(message: LayoutRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(id: number, x = 42): void {
    this.onmessage?.({ data: { id, positions: { a: { x, y: 0 } } } } as unknown as MessageEvent<LayoutResponse>);
  }
  crash(): void {
    this.onerror?.({ message: "boom", preventDefault() {} } as unknown as ErrorEvent);
  }
}

describe("the layouts", () => {
  const request = { nodes: [{ id: "a", size: 10 }], edges: [] };

  it("new data terminates a worker still arranging the old graph, so the new one does not wait behind it", () => {
    const workers: FakeWorker[] = [];
    const layouts = new Layouts(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const done: number[] = [];
    layouts.run(request, (p) => done.push(p.a!.x), () => assert.fail("no failure"));
    layouts.run(request, (p) => done.push(p.a!.x), () => assert.fail("no failure"));
    assert.equal(workers.length, 2);
    assert.equal(workers[0]!.terminated, true, "the busy worker was stopped");
    assert.equal(workers[1]!.terminated, false);
    workers[0]!.answer(workers[0]!.posted[0]!.id, 11);
    assert.equal(done.length, 0, "a stopped worker's answer is dropped");
    workers[1]!.answer(workers[1]!.posted[0]!.id, 17);
    assert.deepEqual(done, [17]);
  });

  it("cancel and dispose terminate active workers and reject their late responses", () => {
    const workers: FakeWorker[] = [];
    const layouts = new Layouts(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const done: number[] = [];
    const run = () => layouts.run(request, (p) => done.push(p.a!.x), () => assert.fail("cancelled"));
    run();
    layouts.cancel();
    assert.equal(workers[0]!.terminated, true);
    workers[0]!.answer(workers[0]!.posted[0]!.id);
    assert.deepEqual(done, [], "a cancelled response never reaches the canvas");

    run();
    layouts.dispose();
    assert.equal(workers[1]!.terminated, true, "no worker outlives the canvas");
    workers[1]!.answer(workers[1]!.posted[0]!.id);
    assert.deepEqual(done, [], "a disposed response never reaches the canvas");
  });

  it("a worker that crashes fails its request and is replaced for the next one", () => {
    const workers: FakeWorker[] = [];
    const layouts = new Layouts(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const failures: string[] = [];
    layouts.run(request, () => assert.fail("it crashed"), (message) => failures.push(message));
    workers[0]!.crash();
    assert.deepEqual(failures, ["boom"]);
    assert.equal(workers[0]!.terminated, true);
    const recovered: number[] = [];
    layouts.run(request, (p) => recovered.push(p.a!.x), () => assert.fail("the next request should recover"));
    workers[1]!.answer(workers[1]!.posted[0]!.id, 29);
    assert.deepEqual(recovered, [29]);
  });
});
