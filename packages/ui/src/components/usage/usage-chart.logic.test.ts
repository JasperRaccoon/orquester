import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChart, linePath, niceScale } from "./usage-chart.logic";

describe("niceScale", () => {
  it("covers the peak with a 1/2/5 step", () => {
    assert.deepEqual(niceScale(87), { max: 100, ticks: [0, 50, 100] });
    assert.deepEqual(niceScale(1234), { max: 1500, ticks: [0, 500, 1000, 1500] });
    assert.deepEqual(niceScale(0.03), { max: 0.03, ticks: [0, 0.01, 0.02, 0.03] });
  });

  it("is a single zero tick with nothing to show", () => {
    assert.deepEqual(niceScale(0), { max: 0, ticks: [0] });
  });
});

describe("buildChart", () => {
  it("scales to the largest single series, not their sum, and draws the largest first", () => {
    const chart = buildChart(
      [
        { id: "small", values: [1, 2, 3] },
        { id: "big", values: [40, 80, 20] }
      ],
      3
    );
    assert.equal(chart.scale.max, 80);
    assert.deepEqual(chart.paths.map((p) => p.id), ["big", "small"]);
  });
});

describe("linePath", () => {
  it("never leaves a segment's value range at its control points (no overshoot)", () => {
    // A step, a spike and a plateau: the cases an unconstrained spline overshoots.
    const ys = [250, 250, 20, 20, 20, 240, 10, 250, 250];
    const points = ys.map((y, i) => ({ x: i * 100, y }));
    const d = linePath(points);
    const curves = [...d.matchAll(/C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/g)];
    assert.equal(curves.length, ys.length - 1);
    curves.forEach((c, i) => {
      const lo = Math.min(ys[i]!, ys[i + 1]!);
      const hi = Math.max(ys[i]!, ys[i + 1]!);
      for (const y of [Number(c[2]), Number(c[4])]) {
        assert.ok(y >= lo - 1e-9 && y <= hi + 1e-9, `segment ${i}: control y ${y} outside [${lo}, ${hi}]`);
      }
    });
  });
});
