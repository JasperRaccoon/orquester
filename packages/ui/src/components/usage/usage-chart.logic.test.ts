import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsdTick } from "../../lib/usage-history-format";
import { buildChart, valueToY } from "./usage-chart.logic";

const scaleOf = (peak: number) => buildChart([{ id: "a", values: [peak] }], 1).scale;

describe("buildChart", () => {
  it("covers the peak with a 1/2/5 step", () => {
    assert.deepEqual(scaleOf(87), { max: 100, ticks: [0, 50, 100], step: 50 });
    assert.deepEqual(scaleOf(1234), { max: 1500, ticks: [0, 500, 1000, 1500], step: 500 });
    assert.deepEqual(scaleOf(0.03), { max: 0.03, ticks: [0, 0.01, 0.02, 0.03], step: 0.01 });
    assert.deepEqual(scaleOf(0), { max: 0, ticks: [0], step: 0 }, "nothing to show");
  });

  it("labels a tiny cost axis with the decimals its step needs, not <$0.01 on every tick", () => {
    const scale = scaleOf(0.003);
    assert.deepEqual(scale.ticks.slice(1).map((t) => formatUsdTick(t, scale.step)), ["$0.001", "$0.002", "$0.003"]);
    const large = scaleOf(1234);
    assert.equal(formatUsdTick(large.ticks[3]!, large.step), "$1,500");
  });

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

  it("never leaves a segment's value range at its control points (no overshoot)", () => {
    // A step, a spike and a plateau: the cases an unconstrained spline overshoots.
    const values = [0, 0, 230, 230, 230, 10, 240, 0, 0];
    const chart = buildChart([{ id: "a", values }], values.length);
    const ys = values.map((v) => valueToY(v, chart.scale.max));
    const curves = [...chart.paths[0]!.line.matchAll(/C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/g)];
    assert.equal(curves.length, ys.length - 1);
    curves.forEach((c, i) => {
      const lo = Math.min(ys[i]!, ys[i + 1]!);
      const hi = Math.max(ys[i]!, ys[i + 1]!);
      for (const y of [Number(c[2]), Number(c[4])]) {
        assert.ok(y >= lo - 0.01 && y <= hi + 0.01, `segment ${i}: control y ${y} outside [${lo}, ${hi}]`);
      }
    });
  });
});
