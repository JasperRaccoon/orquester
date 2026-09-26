/**
 * Which rows play the one-shot rise (§7.3): a row that ARRIVED, never a list
 * the user just opened — a thread's first snapshot, or another agent's
 * drill-in (S10).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { timelineListIdentity } from "./follow";
import { nextRowEnterState, rowEnters, type RowEnterState } from "./row-enter";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

/** Feed each render's rows under `identity`; the ids that rise in each. */
function renders(steps: Array<{ identity: string; ids: string[] }>): string[][] {
  let state: RowEnterState | null = null;
  return steps.map((step) => {
    state = nextRowEnterState(state, rows(...step.ids), step.identity);
    const current = state;
    return step.ids.filter((id) => rowEnters(current, id));
  });
}

const THREAD = timelineListIdentity("s1");
const AGENT_A = timelineListIdentity("s1", "a");
const AGENT_B = timelineListIdentity("s1", "b");

describe("row enter flags", () => {
  it("a list's first rows never rise; rows that arrive after them do", () => {
    assert.deepEqual(
      renders([
        { identity: THREAD, ids: ["r1", "r2"] },
        { identity: THREAD, ids: ["r1", "r2", "r3"] }
      ]),
      [[], ["r3"]]
    );
  });

  it("a cold thread's first snapshot does not rise in whole: an empty render primes nothing", () => {
    assert.deepEqual(
      renders([
        { identity: THREAD, ids: [] },
        { identity: THREAD, ids: ["r1", "r2", "r3"] },
        { identity: THREAD, ids: ["r1", "r2", "r3", "r4"] }
      ]),
      [[], [], ["r4"]]
    );
  });

  it("switching the drill-in from agent A to agent B plays no rise on B's rows", () => {
    assert.deepEqual(
      renders([
        { identity: AGENT_A, ids: ["a1", "a2"] },
        { identity: AGENT_A, ids: ["a1", "a2", "a3"] },
        { identity: AGENT_B, ids: ["b1", "b2"] },
        { identity: AGENT_B, ids: ["b1", "b2", "b3"] }
      ]),
      [[], ["a3"], [], ["b3"]]
    );
  });

  it("the drill-in and its thread are two lists under one session id", () => {
    assert.deepEqual(
      renders([
        { identity: THREAD, ids: ["r1"] },
        { identity: AGENT_A, ids: ["a1", "a2"] }
      ]),
      [[], []]
    );
  });

  it("older history landing ABOVE the rows on screen never rises", () => {
    assert.deepEqual(
      renders([
        { identity: THREAD, ids: ["r5", "r6"] },
        { identity: THREAD, ids: ["r1", "r2", "r5", "r6"] }
      ]),
      [[], []]
    );
  });

  it("a row's flag is decided once and never flipped", () => {
    let state = nextRowEnterState(null, rows("r1"), THREAD);
    state = nextRowEnterState(state, rows("r1", "r2"), THREAD);
    assert.equal(rowEnters(state, "r2"), true);
    state = nextRowEnterState(state, rows("r1", "r2", "r3"), THREAD);
    assert.equal(rowEnters(state, "r2"), true, "still the rise it was given: the row's memo holds");
    assert.equal(rowEnters(state, "r1"), false);
  });
});
