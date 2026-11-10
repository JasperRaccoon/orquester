import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pendingGateFocus, requestGateFocus, resetGateFocus, subscribeGateFocus, takeGateFocus } from "./gate-focus.ts";

describe("gate focus requests", () => {
  it("one per run, the newest wins, taken once, listeners told", () => {
    let told = 0;
    const off = subscribeGateFocus(() => {
      told += 1;
    });
    requestGateFocus({ runId: "r1", gateId: "g1" });
    requestGateFocus({ runId: "r1", gateId: "g2" });
    requestGateFocus({ runId: "r2", gateId: "g9" });
    assert.equal(told, 3);
    assert.equal(pendingGateFocus("r1"), "g2");
    assert.equal(pendingGateFocus(null), null);
    assert.equal(takeGateFocus("r1"), "g2");
    assert.equal(takeGateFocus("r1"), null);
    assert.equal(pendingGateFocus("r2"), "g9");
    resetGateFocus();
    assert.equal(pendingGateFocus("r2"), null);
    off();
  });

  it("ignores a request without a run or a gate", () => {
    requestGateFocus({ runId: "", gateId: "g" });
    requestGateFocus({ runId: "r", gateId: "" });
    assert.equal(pendingGateFocus("r"), null);
  });
});
