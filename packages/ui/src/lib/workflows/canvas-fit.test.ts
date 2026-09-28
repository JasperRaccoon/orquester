import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canvasFitOptions, phoneOpeningViewport } from "./canvas-fit.ts";
import { edge, node, workflow } from "./testing.ts";

describe("canvas fit", () => {
  it("a small graph never goes below 0.7; a big one may go to 0.35", () => {
    const small = workflow([node("t", "trigger.manual"), node("a", "code")], [edge("t", "a")]);
    assert.deepEqual(canvasFitOptions(small), { padding: 0.14, maxZoom: 1, minZoom: 0.7 });
    const big = workflow(Array.from({ length: 12 }, (_, i) => node(`n${i}`, "code")));
    assert.equal(canvasFitOptions(big).minZoom, 0.35);
    assert.equal(canvasFitOptions(small, { run: true }).minZoom, 0.3, "a run shows all of itself");
  });

  it("a phone opens on the trigger and the step after it", () => {
    const wf = workflow(
      [node("t", "trigger.manual"), node("a", "code"), node("b", "code"), node("n", "note")],
      [edge("t", "a"), edge("a", "b")]
    );
    const fit = canvasFitOptions(wf, { phone: true });
    assert.deepEqual(fit.nodes, [{ id: "t" }, { id: "a" }]);
    assert.ok(fit.minZoom >= 0.6);
    assert.equal(canvasFitOptions(workflow([]), { phone: true }).nodes, undefined);
  });
});

describe("phone opening viewport", () => {
  it("puts the first step near the left edge, a little above the middle, readable", () => {
    const wf = workflow(
      [node("a", "code", {}, { position: { x: 400, y: 100 } }), node("t", "trigger.manual", {}, { position: { x: 0, y: 96 } })],
      [edge("t", "a")]
    );
    const view = phoneOpeningViewport(wf, { width: 390, height: 600 })!;
    assert.equal(view.zoom, 0.85);
    assert.equal(view.x, 20, "the trigger's left edge lands 20 px in");
    assert.ok(Math.abs(view.y + (96 + 36) * 0.85 - 600 * 0.36) <= 1);
    assert.equal(phoneOpeningViewport(workflow([]), { width: 390, height: 600 }), null);
  });
});
