/**
 * A render crash never strands the user (§7.1, §7.6, S16): the thread's
 * boundary's "Try again" also leaves an open drill-in — a crashing child row
 * would only crash again — and the drill-in has a boundary of its own, whose
 * "Back to the thread" leaves the composer, the roster and the thread intact.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { DrillInErrorBoundary } from "./roster/DrillInErrorBoundary";

/** Record what the boundary would set, instead of asking an unmounted component. */
function recordState<T extends { setState: unknown }>(boundary: T): unknown[] {
  const states: unknown[] = [];
  (boundary as unknown as { setState: (next: unknown) => void }).setState = (next) => {
    states.push(next);
  };
  return states;
}

describe("ChatErrorBoundary", () => {
  it("Try again hands the reset to the view (which closes a drill-in), then renders again", () => {
    let resets = 0;
    const boundary = new ChatErrorBoundary({
      sessionId: "s1",
      onReset: () => {
        resets += 1;
      },
      children: null
    });
    const states = recordState(boundary);
    boundary.reset();
    assert.equal(resets, 1, "the view's own reset ran");
    assert.deepEqual(states, [{ error: null }]);
  });

  it("without a view reset it only renders again", () => {
    const boundary = new ChatErrorBoundary({ sessionId: "s1", children: null });
    const states = recordState(boundary);
    assert.doesNotThrow(() => boundary.reset());
    assert.deepEqual(states, [{ error: null }]);
  });
});

describe("DrillInErrorBoundary", () => {
  it("catches a child's crash and offers the way back", () => {
    assert.deepEqual(DrillInErrorBoundary.getDerivedStateFromError(new Error("boom")), {
      error: new Error("boom")
    });
    let backs = 0;
    const boundary = new DrillInErrorBoundary({
      agentId: "a1",
      onBack: () => {
        backs += 1;
      },
      children: null
    });
    boundary.back();
    assert.equal(backs, 1, "Back to the thread leaves the drill-in");
  });
});
