/**
 * `GrokWakes` on its own: the gate that holds the frames of a CLI prompt
 * waiting for its turn, in order, and never drops one. The session and the
 * capture-replay driver both run this class; `lifecycle.test.ts` drives it
 * through the real adapter against the mock peer.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { GrokWakes, HELD_FRAMES_MAX, monitorTaskIdsIn } from "./prompt-queue.ts";

const PARENT = "parent-session";

function harness(options: { maxHeld?: number; liveMonitors?: readonly string[] } = {}) {
  /** What happened, in order: turns opened and settled, and each frame handled `name@turn`. */
  const log: string[] = [];
  const debug: string[] = [];
  let turn: string | undefined = "ours";
  const wakes = new GrokWakes(
    {
      rearmMonitors: (ids) =>
        ids.filter((id) => options.liveMonitors?.includes(id) === true).map((id) => ({ id }) as unknown as RuntimeEvent)
    },
    {
      turnOpen: () => turn !== undefined,
      openTurn: (prompt) => {
        turn = prompt.promptId;
        log.push(`open ${prompt.promptId}`);
      },
      emit: () => {},
      notePrompt: () => {},
      debug: (message) => {
        debug.push(message);
      }
    },
    { parentSessionId: () => PARENT, ...(options.maxHeld === undefined ? {} : { maxHeld: options.maxHeld }) }
  );
  const frame = (name: string, params: unknown): void => {
    const handle = (): void => {
      if (wakes.offer(params, handle)) {
        return;
      }
      log.push(`${name}@${turn ?? "-"}`);
    };
    handle();
  };
  const settle = (): void => {
    log.push(`settle ${turn ?? "-"}`);
    turn = undefined;
    wakes.turnSettled();
  };
  return { wakes, log, debug, frame, settle };
}

const announce = (promptId: string, runningText = "") => ({
  sessionId: PARENT,
  entries: [],
  runningPromptId: promptId,
  runningText
});
const naming = (promptId: string) => ({
  sessionId: PARENT,
  update: { sessionUpdate: "agent_message_chunk" },
  _meta: { promptId }
});
const endOf = (promptId: string) => ({
  sessionId: PARENT,
  update: { sessionUpdate: "turn_completed", prompt_id: promptId }
});
const NAMELESS = { sessionId: PARENT, update: { sessionUpdate: "subagent_spawned" } };
const CHILD = { sessionId: "child-session", update: { sessionUpdate: "agent_message_chunk" }, _meta: { promptId: "c" } };

test("every frame after the first one naming a waiting prompt waits behind it, and all come back in order on its turn", () => {
  const h = harness();
  h.wakes.queueChanged(announce("W"));
  h.frame("before", NAMELESS);
  h.frame("call", naming("W"));
  h.frame("spawned", NAMELESS);
  h.frame("child", CHILD);
  h.frame("end", endOf("W"));
  assert.deepEqual(h.log, ["before@ours"], "nothing after the first held frame is handled yet");
  assert.equal(h.wakes.heldFrames, 4);
  h.settle();
  assert.deepEqual(h.log, ["before@ours", "settle ours", "open W", "call@W", "spawned@W", "child@W", "end@W"]);
});

test("past the bound the held frames join the open turn, in order; the prompt keeps a turn for what follows", () => {
  const h = harness({ maxHeld: 3 });
  h.wakes.queueChanged(announce("W"));
  for (const name of ["a", "b", "c", "d"]) {
    h.frame(name, naming("W"));
  }
  assert.deepEqual(h.log, ["a@ours", "b@ours", "c@ours", "d@ours"], "the fourth frame flushed all four, in order");
  h.frame("e", naming("W"));
  assert.deepEqual(h.log.at(-1), "e@ours", "merged: its frames no longer wait");
  h.settle();
  h.frame("f", naming("W"));
  h.frame("end", endOf("W"));
  assert.deepEqual(h.log.slice(-5), ["e@ours", "settle ours", "open W", "f@W", "end@W"]);
});

test("a merged prompt that finishes before the open turn settles gets no turn of its own", () => {
  const h = harness({ maxHeld: 2 });
  h.wakes.queueChanged(announce("W"));
  for (const name of ["a", "b", "c"]) {
    h.frame(name, naming("W"));
  }
  h.frame("end", endOf("W"));
  h.settle();
  assert.deepEqual(h.log, ["a@ours", "b@ours", "c@ours", "end@ours", "settle ours"]);
});

test("the default bound is the documented one", () => {
  const h = harness();
  h.wakes.queueChanged(announce("W"));
  for (let index = 1; index <= HELD_FRAMES_MAX; index += 1) {
    h.frame(`w${index}`, naming("W"));
  }
  assert.deepEqual(h.log, [], "exactly the bound is held");
  h.frame("over", naming("W"));
  assert.equal(h.log.length, HELD_FRAMES_MAX + 1, "one past it, every frame is handled, none lost");
  assert.equal(h.log.at(-1), "over@ours");
});

test("a cancel ends the waiting prompt still running: what it streamed joins the open turn, and it gets no turn", () => {
  const h = harness();
  h.wakes.queueChanged(announce("W"));
  h.frame("a", naming("W"));
  h.wakes.cancelEnds();
  assert.deepEqual(h.log, ["a@ours"]);
  h.settle();
  assert.deepEqual(h.log, ["a@ours", "settle ours"], "no turn for the prompt the cancel ended");
});

test("a cancel ends nothing that already finished: that prompt keeps its frames and its turn", () => {
  const h = harness();
  h.wakes.queueChanged(announce("W"));
  h.frame("a", naming("W"));
  h.frame("end", endOf("W"));
  h.wakes.cancelEnds();
  assert.deepEqual(h.log, [], "a held turn_completed is its prompt's end");
  h.settle();
  assert.deepEqual(h.log, ["settle ours", "open W", "a@W", "end@W"]);
});

test("our prompt running ends every wait: the held frames join our turn, which it continues", () => {
  const h = harness();
  h.wakes.queueChanged({ sessionId: PARENT, entries: [{ id: "P2" }] });
  h.wakes.queueChanged(announce("W"));
  h.frame("a", naming("W"));
  h.frame("spawned", NAMELESS);
  h.frame("end", endOf("W"));
  h.wakes.queueChanged({ sessionId: PARENT, entries: [], runningPromptId: "P2" });
  h.frame("ours", naming("P2"));
  h.settle();
  assert.deepEqual(h.log, ["a@ours", "spawned@ours", "end@ours", "ours@ours", "settle ours"]);
});

test("stopping or exiting with frames held: they join the open turn, in order", () => {
  const h = harness();
  h.wakes.queueChanged(announce("W"));
  h.frame("a", naming("W"));
  h.frame("b", NAMELESS);
  h.wakes.drop("the session stops");
  assert.deepEqual(h.log, ["a@ours", "b@ours"]);
  h.settle();
  assert.deepEqual(h.log.at(-1), "settle ours", "nothing waits for a turn any more");
});

test("a CLI prompt announced with no turn open gets its turn at once, and nothing waits", () => {
  const h = harness();
  h.settle();
  h.wakes.queueChanged(announce("W"));
  h.frame("a", naming("W"));
  assert.deepEqual(h.log, ["settle ours", "open W", "a@W"]);
});

test("a monitor-event block names its monitor in any attribute order", () => {
  assert.deepEqual(
    monitorTaskIdsIn(
      '<monitor-event description="tick watch" task_id="t1">\n[tick watch] tick 1\n</monitor-event>' +
        '<monitor-event task_id="t2">x</monitor-event><monitor-event task_id="t1">y</monitor-event>'
    ),
    ["t1", "t2"]
  );
  assert.deepEqual(monitorTaskIdsIn("<monitor-events task_id=\"no\">"), [], "a different tag is not one");
});

test("a monitor line's wake naming no live monitor says so in one debug line; one naming a live monitor does not", () => {
  const h = harness({ liveMonitors: ["live"] });
  h.settle();
  h.wakes.queueChanged(announce("notifications-1", '<monitor-event task_id="gone">tick</monitor-event>'));
  assert.equal(h.debug.filter((line) => line.includes("names no live monitor")).length, 1);
  h.settle();
  h.wakes.queueChanged(announce("notifications-2", '<monitor-event task_id="live">tick</monitor-event>'));
  h.settle();
  h.wakes.queueChanged(announce("subagent-completed-3"));
  assert.equal(h.debug.filter((line) => line.includes("names no live monitor")).length, 1, "only the first");
});
