import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Layouts, computeLayout, type LayoutRequest, type LayoutResponse, type LayoutWorkerLike } from "./graph-layout.ts";

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
