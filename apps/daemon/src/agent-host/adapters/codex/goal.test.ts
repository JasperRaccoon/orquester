/**
 * Codex adapter — the provider's goal, pure logic (goals §3.2, §6, §6.2).
 *
 * Mapping a `ThreadGoal` onto the normalised `AgentGoal`, naming each change,
 * the progress throttle, the resume snapshot and its carry, the stale-response
 * guard, the `/goal` status text, and the normaliser arms that feed them. The
 * lifecycle against the mock app-server lives in `session.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentGoal, AgentGoalStatus } from "@orquester/api/agent-chat";

import {
  CodexGoalTracker,
  agentGoalFromCodex,
  codexGoalCarry,
  codexGoalStatusSummary,
  formatGoalElapsed
} from "./goal.ts";
import { CodexNormaliser } from "./normalise.ts";
import { CodexUsageTracker } from "./usage.ts";

/** A `ThreadGoal` exactly as the app-server spells it. */
const codexGoal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  threadId: "thread-1",
  objective: "Make the build green",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1_789_950_000,
  updatedAt: 1_789_950_000,
  ...overrides
});

/** The same goal, normalised — what the fold holds and the tracker compares. */
const goal = (overrides: Partial<AgentGoal> = {}): AgentGoal => ({
  objective: "Make the build green",
  status: "active",
  tokensUsed: 0,
  tokenBudget: null,
  elapsedMs: 0,
  setAt: "2026-09-21T00:20:00.000Z",
  ...overrides
});

/** A tracker on a clock the test moves by hand. */
function tracker(options: { known?: AgentGoal | null; carry?: boolean } = {}): {
  goals: CodexGoalTracker;
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  const goals = new CodexGoalTracker({ now: () => now, ...options });
  return {
    goals,
    advance: (ms) => {
      now += ms;
    }
  };
}

describe("codex goal — mapping a ThreadGoal (goals §6.2.1)", () => {
  it("maps every Codex status onto the normalised one", () => {
    const mapped = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].map(
      (status) => agentGoalFromCodex(codexGoal({ status }))?.status
    );
    assert.deepEqual(mapped, [
      "active",
      "paused",
      "blocked",
      "usage-limited",
      "budget-limited",
      "complete"
    ]);
  });

  it("carries the counters, seconds as milliseconds and the creation time as ISO", () => {
    assert.deepEqual(
      agentGoalFromCodex(
        codexGoal({ tokenBudget: 50_000, tokensUsed: 12_345, timeUsedSeconds: 90 })
      ),
      {
        objective: "Make the build green",
        status: "active",
        tokensUsed: 12_345,
        tokenBudget: 50_000,
        elapsedMs: 90_000,
        setAt: "2026-09-21T00:20:00.000Z"
      }
    );
  });

  it("keeps a null budget as null — no budget, not an unknown one", () => {
    assert.equal(agentGoalFromCodex(codexGoal())?.tokenBudget, null);
  });

  it("reads nothing it cannot trust as a goal", () => {
    assert.equal(agentGoalFromCodex(codexGoal({ status: "failedHard" })), null, "unknown status");
    assert.equal(agentGoalFromCodex(codexGoal({ objective: "" })), null, "empty objective");
    assert.equal(agentGoalFromCodex(codexGoal({ objective: 7 })), null, "non-string objective");
    assert.equal(agentGoalFromCodex(null), null);
    assert.equal(agentGoalFromCodex("active"), null);
  });

  it("drops a malformed counter rather than the whole goal", () => {
    assert.deepEqual(
      agentGoalFromCodex(
        codexGoal({ tokensUsed: -1, timeUsedSeconds: "90", createdAt: Number.NaN, tokenBudget: "x" })
      ),
      { objective: "Make the build green", status: "active" }
    );
  });
});

describe("codex goal — what each update is (goals §6.2.1)", () => {
  it("first sight is `set`, with the whole goal", () => {
    const { goals } = tracker();
    assert.deepEqual(goals.notified(goal()), { goal: goal(), change: "set" });
  });

  it("a different objective in place is `replaced`", () => {
    const { goals } = tracker({ known: goal() });
    assert.equal(goals.notified(goal({ objective: "Ship the release" }))?.change, "replaced");
  });

  it("a new goal after a finished one is `set`, not `replaced`", () => {
    // `create_goal` over a complete goal rewrites the row in place with a new
    // creation time — nothing unfinished was replaced.
    const { goals } = tracker({ known: goal({ status: "complete" }) });
    assert.equal(
      goals.notified(goal({ objective: "Next thing", setAt: "2026-09-21T14:13:20.000Z" }))?.change,
      "set"
    );
  });

  it("names each status transition", () => {
    const cases: [AgentGoalStatus, AgentGoalStatus, string][] = [
      ["active", "paused", "paused"],
      ["paused", "active", "resumed"],
      ["blocked", "active", "resumed"],
      ["budget-limited", "active", "resumed"],
      ["usage-limited", "active", "resumed"],
      ["active", "blocked", "blocked"],
      ["active", "budget-limited", "limited"],
      ["active", "usage-limited", "limited"],
      ["active", "complete", "achieved"]
    ];
    for (const [from, to, change] of cases) {
      const { goals } = tracker({ known: goal({ status: from }) });
      assert.deepEqual(
        goals.notified(goal({ status: to })),
        { goal: goal({ status: to }), change },
        `${from} → ${to}`
      );
    }
  });

  it("`cleared` names the goal as it ended, with its latest counters", () => {
    const { goals, advance } = tracker({ known: goal() });
    goals.notified(goal({ tokensUsed: 100 }));
    advance(1_000);
    // Held back by the throttle, but still the provider's latest word.
    goals.notified(goal({ tokensUsed: 900 }));
    assert.deepEqual(goals.notified(null), {
      goal: null,
      change: "cleared",
      previous: goal({ tokensUsed: 900 })
    });
  });

  it("a clear with nothing tracked says nothing", () => {
    const { goals } = tracker();
    assert.equal(goals.notified(null), null);
  });

  it("takes the fold's goal field-wise: a stray `updatedAt` is never quoted back", () => {
    // §5.3 strips `updatedAt` before `knownGoal`; a host that forgot must not
    // leak the fold's own stamp into a row's `previous`.
    const { goals } = tracker({
      known: { ...goal(), updatedAt: "2026-09-24T01:02:03.000Z" } as AgentGoal
    });
    assert.deepEqual(goals.notified(null), { goal: null, change: "cleared", previous: goal() });
  });

  it("a goal after a clear is `set` again", () => {
    const { goals } = tracker({ known: goal() });
    goals.notified(null);
    assert.equal(goals.notified(goal({ objective: "Ship the release" }))?.change, "set");
  });
});

describe("codex goal — progress is throttled to one per 30 s (goals §6)", () => {
  it("holds a counters-only update back inside the window, and the next due one carries the latest counters", () => {
    const { goals, advance } = tracker({ known: goal() });
    assert.equal(goals.notified(goal({ tokensUsed: 100 }))?.change, "progress");
    advance(10_000);
    assert.equal(goals.notified(goal({ tokensUsed: 200 })), null);
    advance(19_999);
    assert.equal(goals.notified(goal({ tokensUsed: 300 })), null);
    advance(1);
    assert.deepEqual(goals.notified(goal({ tokensUsed: 400 })), {
      goal: goal({ tokensUsed: 400 }),
      change: "progress"
    });
  });

  it("never holds back a status change", () => {
    const { goals, advance } = tracker({ known: goal() });
    goals.notified(goal({ tokensUsed: 100 }));
    advance(1_000);
    assert.equal(goals.notified(goal({ tokensUsed: 150, status: "paused" }))?.change, "paused");
  });

  it("any row restarts the window", () => {
    const { goals, advance } = tracker({ known: goal() });
    advance(60_000);
    goals.notified(goal({ status: "paused" }));
    advance(10_000);
    assert.equal(goals.notified(goal({ status: "paused", tokensUsed: 5 })), null);
  });

  it("an exact repeat of what the thread was told is no row, however late", () => {
    const { goals, advance } = tracker({ known: goal() });
    advance(60_000);
    assert.equal(goals.notified(goal()), null);
  });

  it("a held-back update repeated after the window still reaches the thread", () => {
    const { goals, advance } = tracker({ known: goal() });
    goals.notified(goal({ tokensUsed: 100 }));
    advance(10_000);
    assert.equal(goals.notified(goal({ tokensUsed: 200 })), null);
    advance(30_000);
    assert.equal(goals.notified(goal({ tokensUsed: 200 }))?.change, "progress");
  });
});

describe("codex goal — the resume snapshot (goals §6.2.2)", () => {
  it("the goal the fold already has is no news", () => {
    const { goals } = tracker({ known: goal() });
    goals.expectResumeSnapshot();
    assert.equal(goals.notified(goal()), null);
  });

  it("the same goal with moved counters is progress", () => {
    const { goals } = tracker({ known: goal() });
    goals.expectResumeSnapshot();
    assert.deepEqual(goals.notified(goal({ tokensUsed: 5_000 })), {
      goal: goal({ tokensUsed: 5_000 }),
      change: "progress"
    });
  });

  it("a different goal is `restored`, never the transition it looks like", () => {
    const { goals } = tracker({ known: goal() });
    goals.expectResumeSnapshot();
    assert.deepEqual(goals.notified(goal({ status: "paused" })), {
      goal: goal({ status: "paused" }),
      change: "restored"
    });
  });

  it("a goal the fold never saw is `restored`", () => {
    const { goals } = tracker({ known: null });
    goals.expectResumeSnapshot();
    assert.equal(goals.notified(goal())?.change, "restored");
  });

  it("none, while the fold holds an unfinished goal, is `cleared`", () => {
    const { goals } = tracker({ known: goal({ status: "paused" }) });
    goals.expectResumeSnapshot();
    assert.deepEqual(goals.notified(null), {
      goal: null,
      change: "cleared",
      previous: goal({ status: "paused" })
    });
    assert.equal(goals.takeCarry(), null);
  });

  it("none, on an account switch, re-creates the goal instead — and that is `restored`", () => {
    const { goals } = tracker({ known: goal({ status: "blocked" }), carry: true });
    goals.expectResumeSnapshot();
    assert.equal(goals.notified(null), null, "never reported cleared");
    assert.deepEqual(goals.takeCarry(), goal({ status: "blocked" }));
    assert.equal(goals.takeCarry(), null, "carried once");
    assert.deepEqual(goals.notified(goal({ status: "paused" })), {
      goal: goal({ status: "paused" }),
      change: "restored"
    });
  });

  it("a finished goal is neither carried nor reported cleared", () => {
    const { goals } = tracker({ known: goal({ status: "complete" }), carry: true });
    goals.expectResumeSnapshot();
    assert.equal(goals.notified(null), null);
    assert.equal(goals.takeCarry(), null);
  });

  it("only the FIRST goal notification is the snapshot", () => {
    const { goals } = tracker({ known: goal() });
    goals.expectResumeSnapshot();
    goals.notified(goal());
    assert.equal(goals.notified(goal({ status: "paused" }))?.change, "paused");
  });

  it("closing the window makes the next notification an ordinary one", () => {
    const { goals } = tracker({ known: goal() });
    goals.expectResumeSnapshot();
    goals.cancelResumeSnapshot();
    assert.equal(goals.notified(goal({ status: "paused" }))?.change, "paused");
  });
});

describe("codex goal — a fresh thread has no goal", () => {
  it("reports the fold's unfinished goal cleared", () => {
    const { goals } = tracker({ known: goal() });
    assert.deepEqual(goals.freshThread(), { goal: null, change: "cleared", previous: goal() });
  });

  it("re-creates it on an account switch", () => {
    const { goals } = tracker({ known: goal(), carry: true });
    assert.equal(goals.freshThread(), null);
    assert.deepEqual(goals.takeCarry(), goal());
  });

  it("says nothing when the fold had no goal", () => {
    const { goals } = tracker({ known: null, carry: true });
    assert.equal(goals.freshThread(), null);
    assert.equal(goals.takeCarry(), null);
  });
});

describe("codex goal — carrying a goal across an account switch (goals §6.2.2)", () => {
  it("re-creates it active only when it was active", () => {
    assert.deepEqual(codexGoalCarry(goal({ tokenBudget: 50_000 })), {
      objective: "Make the build green",
      status: "active",
      tokenBudget: 50_000
    });
    for (const status of ["paused", "blocked", "budget-limited", "usage-limited"] as const) {
      assert.equal(codexGoalCarry(goal({ status })).status, "paused", status);
    }
  });

  it("keeps no budget as no budget, and omits one it never knew", () => {
    assert.equal(codexGoalCarry(goal({ tokenBudget: null })).tokenBudget, null);
    assert.equal("tokenBudget" in codexGoalCarry({ objective: "X", status: "active" }), false);
  });

  it("a carry that failed reports the goal cleared", () => {
    const { goals } = tracker({ known: goal(), carry: true });
    goals.expectResumeSnapshot();
    goals.notified(null);
    goals.takeCarry();
    assert.deepEqual(goals.carryFailed(), { goal: null, change: "cleared", previous: goal() });
  });
});

describe("codex goal — a response a notification overtook is discarded (goals §6.2.5)", () => {
  it("a response with no notification in between is observed", () => {
    const { goals } = tracker();
    const sentAt = goals.notificationCount;
    assert.equal(goals.responded(goal(), sentAt)?.change, "set");
  });

  it("a response older than a later notification is dropped", () => {
    const { goals } = tracker();
    const sentAt = goals.notificationCount;
    goals.notified(goal({ status: "paused" }));
    assert.equal(goals.responded(goal(), sentAt), null);
    assert.equal(goals.current?.status, "paused");
  });
});

describe("codex goal — nothing is read over a pending resume snapshot (fix round 1)", () => {
  it("a reply read while the snapshot is pending is stale, and the snapshot still decides the carry", () => {
    // The account-switch race: the new home has no goal yet, so a `get`
    // answered before the snapshot must not clear the goal the carry is about
    // to re-create.
    const { goals } = tracker({ known: goal({ status: "paused" }), carry: true });
    goals.expectResumeSnapshot();
    const sentAt = goals.notificationCount;
    assert.equal(goals.isStale(sentAt), true);
    assert.equal(goals.responded(null, sentAt), null, "no `cleared` off a reply");
    assert.equal(goals.notified(null), null);
    assert.deepEqual(goals.takeCarry(), goal({ status: "paused" }), "the carry still happens");
  });

  it("an unreadable goal still counts: it closes the window and makes an earlier reply stale", () => {
    const { goals } = tracker({ known: goal() });
    goals.expectResumeSnapshot();
    const sentAt = goals.notificationCount;
    goals.unreadable();
    assert.equal(goals.isStale(sentAt), true);
    assert.equal(goals.responded(goal({ status: "paused" }), sentAt), null);
    assert.equal(
      goals.notified(goal({ status: "paused" }))?.change,
      "paused",
      "the window is closed: the next update is an ordinary one"
    );
  });

  it("is settled only once no snapshot is pending and no carry is in flight", () => {
    const { goals } = tracker({ known: goal({ status: "paused" }), carry: true });
    assert.equal(goals.settled, true, "a fresh session has nothing pending");
    goals.expectResumeSnapshot();
    assert.equal(goals.settled, false, "the snapshot is pending");
    goals.notified(null);
    assert.equal(goals.settled, false, "a carry is requested");
    goals.takeCarry();
    assert.equal(goals.settled, false, "a carry is in flight");
    goals.notified(goal({ status: "paused" }));
    assert.equal(goals.settled, true, "the carried goal has come back");
  });

  it("a failed carry settles too", () => {
    const { goals } = tracker({ known: goal({ status: "paused" }), carry: true });
    goals.expectResumeSnapshot();
    goals.notified(null);
    goals.takeCarry();
    goals.carryFailed();
    assert.equal(goals.settled, true);
  });
});

describe("codex goal — the `/goal` status text (goals §6.2.3)", () => {
  it("says so when there is no goal", () => {
    assert.equal(codexGoalStatusSummary(null), "No goal is set.");
  });

  it("names the status, the objective, the tokens against the budget and the time", () => {
    assert.equal(
      codexGoalStatusSummary(goal({ tokensUsed: 12_345, tokenBudget: 50_000, elapsedMs: 5_400_000 })),
      "Goal active: Make the build green — 12,345/50,000 tokens, 1h 30m"
    );
  });

  it("names tokens without a budget", () => {
    assert.equal(
      codexGoalStatusSummary(goal({ status: "usage-limited", tokensUsed: 7 })),
      "Goal usage-limited: Make the build green — 7 tokens, 0s"
    );
  });

  it("leaves out what it does not know", () => {
    assert.equal(
      codexGoalStatusSummary({ objective: "Tidy up", status: "paused" }),
      "Goal paused: Tidy up"
    );
  });

  it("cuts a long objective", () => {
    assert.equal(
      codexGoalStatusSummary({ objective: "a".repeat(300), status: "active" }),
      `Goal active: ${"a".repeat(199)}…`
    );
  });

  it("formats elapsed time the way Codex's own /goal does", () => {
    const cases: [number, string][] = [
      [0, "0s"],
      [59_000, "59s"],
      [60_000, "1m"],
      [1_800_000, "30m"],
      [5_400_000, "1h 30m"],
      [7_200_000, "2h"],
      [86_399_000, "23h 59m"],
      [86_400_000, "1d 0h 0m"],
      [(2 * 86_400 + 23 * 3_600 + 42 * 60) * 1_000, "2d 23h 42m"]
    ];
    for (const [ms, text] of cases) {
      assert.equal(formatGoalElapsed(ms), text, String(ms));
    }
  });
});

describe("codex goal — the notifications become thread.goal.updated (goals §6.2.1)", () => {
  it("thread/goal/updated carries the whole goal, its turn and the raw frame", () => {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const params = { threadId: "thread-1", turnId: "turn-1", goal: codexGoal({ tokensUsed: 10 }) };
    const events = normaliser.notification("thread/goal/updated", params);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event!.type, "thread.goal.updated");
    assert.deepEqual(event!.payload, { goal: goal({ tokensUsed: 10 }), change: "set" });
    assert.equal(event!.turnId, "turn-1");
    assert.equal(event!.raw?.method, "thread/goal/updated");
  });

  it("a goal set outside any turn carries no turn id", () => {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const [event] = normaliser.notification("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: codexGoal()
    });
    assert.equal(event!.turnId, undefined);
  });

  it("thread/goal/cleared after a tracked goal is `cleared`", () => {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    normaliser.notification("thread/goal/updated", { threadId: "thread-1", turnId: null, goal: codexGoal() });
    const [event] = normaliser.notification("thread/goal/cleared", { threadId: "thread-1" });
    assert.deepEqual(event!.payload, { goal: null, change: "cleared", previous: goal() });
  });

  it("thread/goal/cleared with nothing tracked is nothing — fixture 07's post-resume frame", () => {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    assert.deepEqual(normaliser.notification("thread/goal/cleared", { threadId: "thread-1" }), []);
  });

  it("an unreadable goal is a warning, never a silent drop", () => {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const [event] = normaliser.notification("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: codexGoal({ status: "someNewStatus" })
    });
    assert.equal(event!.type, "runtime.warning");
  });

  it("an unreadable goal still counts as the provider speaking: counted, and it closes the snapshot window", () => {
    const goals = new CodexGoalTracker({ known: goal() });
    goals.expectResumeSnapshot();
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker(), goals });
    normaliser.notification("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: codexGoal({ status: "someNewStatus" })
    });
    assert.equal(goals.notificationCount, 1, "a reply sent before it is stale");
    assert.equal(goals.settled, true, "no snapshot is pending any more");
  });

  it("feeds the tracker the session owns", () => {
    const goals = new CodexGoalTracker({ known: goal() });
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker(), goals });
    const [event] = normaliser.notification("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: codexGoal({ status: "paused" })
    });
    assert.equal((event!.payload as { change: string }).change, "paused");
    assert.equal(goals.current?.status, "paused");
  });
});
