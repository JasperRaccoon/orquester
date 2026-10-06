import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowBlockStatus, WorkflowNodeType } from "./types.ts";
import {
  computeReadiness,
  downstreamOf,
  reachableFromTriggers,
  upstreamOf,
  type ReadinessState
} from "./graph.ts";

interface TestNode {
  id: string;
  type: WorkflowNodeType;
  config?: unknown;
}
interface TestEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}

function graph(nodes: [string, WorkflowNodeType, unknown?][], edges: [string, string, string?][]) {
  return {
    nodes: nodes.map(([id, type, config]): TestNode => ({ id, type, config: config ?? {} })),
    edges: edges.map(([source, target, handle], index): TestEdge => ({
      id: `e${index}:${source}->${target}`,
      source,
      target,
      sourceHandle: handle ?? "success"
    }))
  };
}

function state(status: Record<string, WorkflowBlockStatus>, handle: Record<string, string> = {}): ReadinessState {
  return { status, handle };
}

describe("order and reachability", () => {
  const g = graph(
    [
      ["n", "note"],
      ["c", "code"],
      ["t", "trigger.manual"],
      ["a", "agent"],
      ["b", "shell"],
      ["m", "merge"],
      ["x", "code"]
    ],
    [
      ["t", "a"],
      ["t", "b"],
      ["a", "m"],
      ["b", "m"],
      ["m", "c"]
    ]
  );

  it("upstream / downstream / reachable", () => {
    assert.deepEqual([...upstreamOf(g, "c")].sort(), ["a", "b", "m", "t"]);
    assert.deepEqual([...downstreamOf(g, "t")].sort(), ["a", "b", "c", "m"]);
    assert.deepEqual([...upstreamOf(g, "t")], []);
    assert.deepEqual([...reachableFromTriggers(g)].sort(), ["a", "b", "c", "m", "t"]);
  });
});

describe("computeReadiness", () => {
  it("a straight line: the next block is ready once the previous finished", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["a", "code"],
        ["b", "code"]
      ],
      [
        ["t", "a"],
        ["a", "b"]
      ]
    );
    assert.deepEqual(computeReadiness(g, state({ t: "succeeded" })).ready, ["a"]);
    const running = computeReadiness(g, state({ t: "succeeded", a: "running" }));
    assert.deepEqual(running.ready, []);
    assert.deepEqual(running.skip, []);
    assert.equal(running.edgeStates["e1:a->b"], "pending");
    assert.deepEqual(computeReadiness(g, state({ t: "succeeded", a: "succeeded" })).ready, ["b"]);
  });

  it("triggers that did not fire are skipped: their paths die", () => {
    const g = graph(
      [
        ["manual", "trigger.manual"],
        ["sched", "trigger.schedule"],
        ["onlySched", "code"],
        ["both", "code"]
      ],
      [
        ["sched", "onlySched"],
        ["manual", "both"],
        ["sched", "both"]
      ]
    );
    const readiness = computeReadiness(g, state({ manual: "succeeded", sched: "skipped" }));
    assert.deepEqual(readiness.ready, ["both"]);
    assert.deepEqual(readiness.skip, ["onlySched"]);
    assert.equal(readiness.edgeStates["e0:sched->onlySched"], "dead");
    assert.equal(readiness.edgeStates["e1:manual->both"], "live");
  });

  it("IF: the untaken branch is skipped, transitively", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["if", "if"],
        ["yes", "code"],
        ["yes2", "code"],
        ["no", "code"],
        ["no2", "shell"]
      ],
      [
        ["t", "if"],
        ["if", "yes", "true"],
        ["yes", "yes2"],
        ["if", "no", "false"],
        ["no", "no2"]
      ]
    );
    const readiness = computeReadiness(g, state({ t: "succeeded", if: "succeeded" }, { if: "true" }));
    assert.deepEqual(readiness.ready, ["yes"]);
    assert.deepEqual(readiness.skip, ["no", "no2"]);
    assert.equal(readiness.edgeStates["e4:no->no2"], "dead");
  });

  it("diamond: the join waits for both branches", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["a", "code"],
        ["b", "code"],
        ["j", "code"]
      ],
      [
        ["t", "a"],
        ["t", "b"],
        ["a", "j"],
        ["b", "j"]
      ]
    );
    assert.deepEqual(computeReadiness(g, state({ t: "succeeded" })).ready, ["a", "b"]);
    assert.deepEqual(computeReadiness(g, state({ t: "succeeded", a: "succeeded", b: "running" })).ready, []);
    assert.deepEqual(computeReadiness(g, state({ t: "succeeded", a: "succeeded", b: "succeeded" })).ready, ["j"]);
  });

  it("diamond after an IF: the join runs on the one live branch", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["if", "if"],
        ["a", "code"],
        ["b", "code"],
        ["m", "merge"]
      ],
      [
        ["t", "if"],
        ["if", "a", "true"],
        ["if", "b", "false"],
        ["a", "m"],
        ["b", "m"]
      ]
    );
    const afterIf = computeReadiness(g, state({ t: "succeeded", if: "succeeded" }, { if: "false" }));
    assert.deepEqual(afterIf.ready, ["b"]);
    assert.deepEqual(afterIf.skip, ["a"]);
    assert.deepEqual(computeReadiness(g, state({ t: "succeeded", if: "succeeded", a: "skipped" }, { if: "false" })).ready, [
      "b"
    ]);
    const done = computeReadiness(
      g,
      state({ t: "succeeded", if: "succeeded", a: "skipped", b: "succeeded" }, { if: "false" })
    );
    assert.deepEqual(done.ready, ["m"]);
  });

  it("error routes: a failure takes the error edge; success kills it", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["a", "agent"],
        ["ok", "code"],
        ["fail", "stop"]
      ],
      [
        ["t", "a"],
        ["a", "ok", "success"],
        ["a", "fail", "error"]
      ]
    );
    const failed = computeReadiness(g, state({ t: "succeeded", a: "failed" }));
    assert.deepEqual(failed.ready, ["fail"]);
    assert.deepEqual(failed.skip, ["ok"]);
    const succeeded = computeReadiness(g, state({ t: "succeeded", a: "succeeded" }));
    assert.deepEqual(succeeded.ready, ["ok"]);
    assert.deepEqual(succeeded.skip, ["fail"]);
    const explicit = computeReadiness(g, state({ t: "succeeded", a: "failed" }, { a: "error" }));
    assert.deepEqual(explicit.ready, ["fail"]);
  });

  it("one stop fed by several error edges runs on whichever fired", () => {
    const g = graph(
      [
        ["t", "trigger.schedule"],
        ["fetch", "code"],
        ["fix", "agent"],
        ["done", "code"],
        ["stop", "stop"]
      ],
      [
        ["t", "fetch"],
        ["fetch", "fix"],
        ["fix", "done"],
        ["fetch", "stop", "error"],
        ["fix", "stop", "error"],
        ["done", "stop", "error"]
      ]
    );
    const early = computeReadiness(g, state({ t: "succeeded", fetch: "failed" }));
    assert.deepEqual(early.skip, ["fix", "done"]);
    assert.deepEqual(early.ready, ["stop"]);
    const allGood = computeReadiness(g, state({ t: "succeeded", fetch: "succeeded", fix: "succeeded", done: "succeeded" }));
    assert.deepEqual(allGood.ready, []);
    assert.deepEqual(allGood.skip, ["stop"]);
  });

  it("merge in first mode starts on the first live input", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["a", "code"],
        ["b", "code"],
        ["first", "merge", { mode: "first" }],
        ["all", "merge", { mode: "all" }]
      ],
      [
        ["t", "a"],
        ["t", "b"],
        ["a", "first"],
        ["b", "first"],
        ["a", "all"],
        ["b", "all"]
      ]
    );
    const oneIn = computeReadiness(g, state({ t: "succeeded", a: "succeeded", b: "running" }));
    assert.deepEqual(oneIn.ready, ["first"]);
    const later = computeReadiness(g, state({ t: "succeeded", a: "succeeded", b: "succeeded", first: "succeeded" }));
    assert.deepEqual(later.ready, ["all"], "a merge that already ran ignores later arrivals");
    const allDead = computeReadiness(g, state({ t: "succeeded", a: "skipped", b: "skipped" }));
    assert.deepEqual(allDead.skip, ["first", "all"]);
  });

  it("switch: the taken case lives; a switch that matched nothing kills every output", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["sw", "switch", { cases: [{}, {}], fallback: false }],
        ["c0", "code"],
        ["c1", "code"]
      ],
      [
        ["t", "sw"],
        ["sw", "c0", "case:0"],
        ["sw", "c1", "case:1"]
      ]
    );
    const case1 = computeReadiness(g, state({ t: "succeeded", sw: "succeeded" }, { sw: "case:1" }));
    assert.deepEqual(case1.ready, ["c1"]);
    assert.deepEqual(case1.skip, ["c0"]);
    // No handle recorded: the default "success" handle matches no switch edge.
    const none = computeReadiness(g, state({ t: "succeeded", sw: "succeeded" }));
    assert.deepEqual(none.skip, ["c0", "c1"]);
  });

  it("a cancelled source kills its edges; an unconnected block is skipped", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["a", "code"],
        ["b", "code"],
        ["orphan", "code"]
      ],
      [
        ["t", "a"],
        ["a", "b"]
      ]
    );
    const readiness = computeReadiness(g, state({ t: "succeeded", a: "cancelled" }));
    assert.deepEqual(readiness.skip, ["b", "orphan"]);
    assert.deepEqual(readiness.ready, []);
  });

  it("finished, running and waiting blocks are neither ready nor skipped; triggers never are", () => {
    const g = graph(
      [
        ["t", "trigger.manual"],
        ["a", "code"],
        ["w", "wait"]
      ],
      [
        ["t", "a"],
        ["t", "w"]
      ]
    );
    const readiness = computeReadiness(g, state({ t: "succeeded", a: "succeeded", w: "waiting" }));
    assert.deepEqual(readiness, {
      ready: [],
      skip: [],
      edgeStates: { "e0:t->a": "live", "e1:t->w": "live" }
    });
    const before = computeReadiness(g, state({}));
    assert.deepEqual(before.ready, []);
    assert.deepEqual(before.skip, []);
  });
});
