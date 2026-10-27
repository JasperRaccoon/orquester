import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Layouts, computeLayout, warmStart, type LayoutRequest, type LayoutResponse, type LayoutWorkerLike } from "./graph-layout.ts";

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

  it("keeps concepts from overlapping above the old 150-concept layout boundary", () => {
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
        assert.ok(clear >= 0, `${nodes[i]!.id} and ${nodes[j]!.id} overlap by ${(-clear).toFixed(1)}`);
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

  it("reuses shown coordinates when the graph grows or trims, but starts a different graph afresh", () => {
    assert.deepEqual(warmStart(["e", "a", "b", "c", "d"], placed), {
      a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 0, y: 100 }, d: { x: 100, y: 100 }
    });
    assert.deepEqual(warmStart(["a", "b", "c"], placed), {
      a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 0, y: 100 }
    });
    assert.equal(warmStart(["x", "y", "z"], placed), null);
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
    assert.equal(workers[0]!.terminated, true, "the busy worker was stopped");
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
