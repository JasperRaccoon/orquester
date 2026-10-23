import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DeferredFit, Layouts, computeLayout, spread, type LayoutRequest, type LayoutResponse, type LayoutWorkerLike } from "./graph-layout.ts";

describe("the graph layout", () => {
  it("places every concept, at distinct points, ignoring edges it cannot draw", () => {
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
    const points = new Set(Object.values(positions).map(({ x, y }) => `${Math.round(x)},${Math.round(y)}`));
    assert.equal(points.size, 3);
  });

  it("lays out an empty graph", () => {
    assert.deepEqual(computeLayout({ nodes: [], edges: [] }), {});
  });
});

describe("spreading a packed layout", () => {
  it("scales a crowded layout about its centre and leaves a roomy one alone", () => {
    const crowded = { a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, c: { x: 0, y: 2 }, d: { x: 2, y: 2 } };
    const sizes = [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }];
    const out = spread(crowded, sizes);
    assert.ok(out.b!.x - out.a!.x > 40, "room for 20 px concepts");
    assert.equal((out.a!.x + out.b!.x) / 2, 1, "about the centre");
    const roomy = { a: { x: 0, y: 0 }, b: { x: 1000, y: 1000 } };
    assert.equal(spread(roomy, sizes.slice(0, 2)), roomy);
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
  answer(id: number): void {
    this.onmessage?.({ data: { id, positions: { a: { x: id, y: id } } } } as unknown as MessageEvent<LayoutResponse>);
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
    workers[0]!.answer(workers[0]!.posted[0]!.id);
    assert.equal(done.length, 0, "a stopped worker's answer is dropped");
    workers[1]!.answer(workers[1]!.posted[0]!.id);
    assert.deepEqual(done, [2]);

    // An idle worker is reused.
    layouts.run(request, (p) => done.push(p.a!.x), () => assert.fail("no failure"));
    assert.equal(workers.length, 2);
    assert.equal(workers[1]!.posted.length, 2);
  });

  it("cancel stops a busy worker; dispose terminates the worker", () => {
    const workers: FakeWorker[] = [];
    const layouts = new Layouts(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    layouts.run(request, () => assert.fail("cancelled"), () => assert.fail("cancelled"));
    layouts.cancel();
    assert.equal(workers[0]!.terminated, true);
    layouts.run(request, () => undefined, () => undefined);
    workers[1]!.answer(workers[1]!.posted[0]!.id);
    layouts.dispose();
    assert.equal(workers[1]!.terminated, true, "no worker outlives the canvas");
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
    layouts.run(request, () => undefined, () => undefined);
    assert.equal(workers.length, 2);
  });
});

describe("fitting the graph", () => {
  const viewport = (width: number, height: number) => {
    const fits: number[] = [];
    return { fits, cy: { width: () => width, height: () => height, fit: (_e?: undefined, padding?: number) => fits.push(padding ?? 0) } };
  };

  it("fits a shown graph at once", () => {
    const { cy, fits } = viewport(800, 600);
    new DeferredFit().fit(cy);
    assert.equal(fits.length, 1);
  });

  it("waits while the tab is hidden (no size), then fits once it has a size again", () => {
    const fit = new DeferredFit();
    const hidden = viewport(0, 0);
    fit.fit(hidden.cy);
    assert.equal(hidden.fits.length, 0, "a zero-size viewport is never fitted");
    const shown = viewport(800, 600);
    fit.whenSized(shown.cy);
    assert.equal(shown.fits.length, 1);
    fit.whenSized(shown.cy);
    assert.equal(shown.fits.length, 1, "only once");
  });
});
