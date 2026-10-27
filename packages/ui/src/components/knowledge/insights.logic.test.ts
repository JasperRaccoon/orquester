import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INSIGHTS_SECTIONS, insightsAreEmpty, insightsCountText, insightsQueryOf } from "./insights.logic.ts";

describe("the Insights view's rules", () => {
  it("asks for every collection, or the ones filtered to in a stable order", () => {
    assert.deepEqual(insightsQueryOf([]), {});
    assert.deepEqual(insightsQueryOf(["kc_seo", "kc_ads"]), { collections: "kc_ads,kc_seo" });
  });

  it("lists the four sections, contradictions first", () => {
    assert.deepEqual(
      INSIGHTS_SECTIONS.map((s) => [s.key, s.title]),
      [
        ["contradictions", "Contradictions"],
        ["bridges", "Bridges"],
        ["singleSource", "Single source"],
        ["gaps", "Link gaps"]
      ]
    );
  });

  it("counts a section from its total, saying when the list was cut", () => {
    assert.equal(insightsCountText(3, 3), "3");
    assert.equal(insightsCountText(1234, 20), "20 of 1,234");
    assert.equal(insightsCountText(0, 0), "0");
  });

  it("is empty only when every total is", () => {
    assert.equal(insightsAreEmpty({ totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 } }), true);
    assert.equal(insightsAreEmpty({ totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 1 } }), false);
  });
});
