import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayOutline } from "./outline-display.ts";
import { edge, node, workflow } from "./testing.ts";

describe("displayOutline", () => {
  it("a success/failure chain reads flat; its shared failure handler is one labelled row", () => {
    const wf = workflow(
      [node("t", "trigger.schedule"), node("f", "code"), node("a", "agent"), node("m", "code"), node("x", "stop")],
      [edge("t", "f"), edge("f", "a"), edge("a", "m"), edge("f", "x", "error"), edge("a", "x", "error"), edge("m", "x", "error")]
    );
    const items = displayOutline(wf);
    assert.deepEqual(
      items.map((item) => [item.kind, item.nodeId, item.displayDepth, item.labelled]),
      [
        ["node", "t", 0, false],
        ["node", "f", 0, false],
        ["node", "a", 0, false],
        ["node", "m", 0, false],
        ["node", "x", 0, false]
      ],
      "no staircase, no failure join-refs"
    );
    assert.equal(items.at(-1)!.failureJoin, true);
    assert.equal(items[2]!.underParent, true);
  });

  it("branches stay indented and labelled; a lone failure branch too", () => {
    const wf = workflow(
      [node("t", "trigger.manual"), node("i", "if"), node("y", "agent"), node("n", "code"), node("z", "http")],
      [edge("t", "i"), edge("i", "y", "true"), edge("i", "n", "false"), edge("y", "z", "error")]
    );
    const items = displayOutline(wf);
    const at = (id: string) => items.find((item) => item.nodeId === id && item.kind === "node")!;
    assert.deepEqual([at("y").displayDepth, at("y").labelled], [1, true]);
    assert.deepEqual([at("n").displayDepth, at("n").labelled], [1, true]);
    assert.deepEqual([at("z").displayDepth, at("z").labelled, at("z").underParent], [2, true, true]);
  });
});
