import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadActivityItem, ThreadItem, ThreadMessageItem, Turn } from "@orquester/api/agent-chat";

import {
  trimToWireWindow,
  wireWindowCut
} from "./wire-window.ts";

const AT = "2026-10-24T00:00:00.000Z";

function turn(n: number, state: Turn["state"] = "completed"): Turn {
  return {
    turnId: `t-${n}`,
    state,
    turnCount: null,
    requestedAt: AT,
    startedAt: AT,
    completedAt: state === "completed" ? AT : null,
    assistantMessageId: null,
    userMessageId: `user:t-${n}`
  };
}

function prompt(n: number): ThreadMessageItem {
  // A prompt is written before its turn has an id: turnless, named by the turn.
  return {
    kind: "message",
    id: `user:t-${n}`,
    role: "user",
    text: `prompt ${n}`,
    turnId: null,
    streaming: false,
    createdAt: AT,
    updatedAt: AT
  } as ThreadMessageItem;
}

function reply(n: number, extra: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  return {
    kind: "message",
    id: `reply:t-${n}`,
    role: "assistant",
    text: `reply ${n}`,
    turnId: `t-${n}`,
    streaming: false,
    createdAt: AT,
    updatedAt: AT,
    ...extra
  } as ThreadMessageItem;
}

function row(id: string, turnId: string | null, activityKind = "tool.completed", payload: Record<string, unknown> = {}, extra: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  return {
    kind: "activity",
    id,
    tone: "tool",
    activityKind,
    summary: id,
    payload,
    turnId,
    createdAt: AT,
    updatedAt: AT,
    ...extra
  };
}

/** `count` settled turns, each a prompt, a call (started + completed) and a reply. */
function thread(count: number): { turns: Turn[]; items: ThreadItem[] } {
  const turns: Turn[] = [];
  const items: ThreadItem[] = [];
  for (let n = 1; n <= count; n += 1) {
    turns.push(turn(n));
    items.push(
      prompt(n),
      row(`call-${n}:start`, `t-${n}`, "tool.started", { toolUseId: `call-${n}` }),
      row(`call-${n}:done`, `t-${n}`, "tool.completed", { toolUseId: `call-${n}` }),
      reply(n)
    );
  }
  return { turns, items };
}

const everyRowBelow = (candidates: readonly ThreadItem[]): ReadonlySet<ThreadItem> => new Set(candidates);
const ids = (items: readonly ThreadItem[]) => items.map((item) => item.id);

describe("wire window — where the frame's window begins", () => {
  it("keeps the newest ten started turns, and nothing at all for a short thread", () => {
    assert.equal(wireWindowCut(thread(2).turns, thread(2).items), null);
    assert.equal(wireWindowCut(thread(10).turns, thread(10).items), null);
    const long = thread(15);
    const cut = wireWindowCut(long.turns, long.items);
    assert.equal(cut?.oldestKept.turnId, "t-6");
    assert.deepEqual([...cut!.trimmable], ["t-1", "t-2", "t-3", "t-4", "t-5"]);
    // A prompt belongs to the turn that names it; any other turnless row to none.
    assert.equal(cut!.turnOf(prompt(3)), "t-3");
    assert.equal(cut!.turnOf(row("loose", null)), null);
  });

  it("keeps fewer turns once their rows pass the budget, but never fewer than two", () => {
    const long = thread(12);
    const big = "x".repeat(512 * 1024);
    // Turn 11 alone is past the budget: turns 11 and 12 are kept, the minimum.
    long.items.push(row("huge-11", "t-11", "tool.completed", { detail: big }));
    assert.equal(wireWindowCut(long.turns, long.items)?.oldestKept.turnId, "t-11");
    // Turn 12 alone is past it: still two turns.
    long.items.push(row("huge-12", "t-12", "tool.completed", { detail: big }));
    assert.equal(wireWindowCut(long.turns, long.items)?.oldestKept.turnId, "t-11");
    // A subagent's rows are never trimmed, so they do not count against it.
    const agents = thread(12);
    agents.items.push(row("agent-11", "t-11", "tool.completed", { detail: big }, { agentId: "agent-a" }));
    assert.equal(wireWindowCut(agents.turns, agents.items)?.oldestKept.turnId, "t-3");
  });

  it("never cuts past a turn that has not settled", () => {
    const long = thread(15);
    long.turns[3] = turn(4, "running");
    assert.equal(wireWindowCut(long.turns, long.items)?.oldestKept.turnId, "t-4");
    long.turns[0] = turn(1, "running");
    assert.equal(wireWindowCut(long.turns, long.items), null);
  });
});

describe("wire window — what the frame leaves to load older", () => {
  const long = () => thread(15);
  const cutOf = (t: { turns: Turn[]; items: ThreadItem[] }) => {
    const cut = wireWindowCut(t.turns, t.items);
    assert.ok(cut);
    return cut;
  };

  it("drops the settled older turns' rows, prompts included, and keeps the newest turns whole", () => {
    const t = long();
    const kept = trimToWireWindow(t.items, cutOf(t), everyRowBelow);
    assert.ok(kept);
    assert.deepEqual(
      ids(kept),
      ids(t.items.slice(5 * 4)),
      "turns 6..15 whole, turns 1..5 gone"
    );
  });

  it("keeps a row the caller does not place below the cut, and answers null when nothing goes", () => {
    const t = long();
    const kept = trimToWireWindow(t.items, cutOf(t), (candidates) => new Set(candidates.filter((item) => item.id !== "reply:t-2")));
    assert.ok(kept?.some((item) => item.id === "reply:t-2"));
    assert.equal(trimToWireWindow(t.items, cutOf(t), () => new Set()), null);
  });

  it("never drops a subagent's row, a task or roster row, an open request, a compaction, a goal row or open work", () => {
    const t = long();
    const protectedRows: ThreadItem[] = [
      row("agent-row", "t-1", "tool.completed", { toolUseId: "agent-call" }, { agentId: "agent-a" }),
      // Unstamped, but its call is the agent's: the agent's drill-in shows it.
      row("agent-chunk", "t-1", "tool.output", { toolUseId: "agent-call" }),
      reply(1, { id: "agent-reasoning", role: "reasoning", agentId: "agent-a" }),
      row("launch", "t-1", "task.started", { taskId: "agent-a", agentKind: "agent" }),
      row("progress", "t-2", "tool.progress", { taskId: "shell-1" }),
      row("open-question", "t-2", "user-input.requested", { requestId: "q-1" }),
      row("compacted", "t-3", "context-compaction", { state: "compacted" }),
      row("goal", "t-3", "goal.updated", {}),
      row("running-call", "t-4", "tool.started", { toolUseId: "still-running" })
    ];
    const items = [...t.items, ...protectedRows];
    const kept = trimToWireWindow(items, cutOf(t), everyRowBelow);
    assert.ok(kept);
    for (const item of protectedRows) {
      assert.ok(kept.includes(item), `${item.id} is kept`);
    }
    assert.ok(!kept.some((item) => item.id === "reply:t-1"));
  });

  it("drops a resolved request's rows with their turn", () => {
    const t = long();
    const asked = row("asked", "t-2", "approval.requested", { requestId: "a-1" });
    const answered = row("answered", "t-2", "approval.resolved", { requestId: "a-1" });
    // A later request of a kept turn is the newest of each kind.
    const later = [
      row("asked-later", "t-14", "approval.requested", { requestId: "a-2" }),
      row("answered-later", "t-14", "approval.resolved", { requestId: "a-2" })
    ];
    const kept = trimToWireWindow([...t.items.slice(0, 8), asked, answered, ...t.items.slice(8), ...later], cutOf(t), everyRowBelow);
    assert.ok(kept && !kept.includes(asked) && !kept.includes(answered));
    assert.ok(later.every((item) => kept.includes(item)));
  });

  it("keeps the newest parent row of each kind and the newest parent message of each role", () => {
    const t = long();
    const plan = row("plan", "t-2", "turn.plan.updated", { plan: [] });
    const thinking = reply(3, { id: "thinking-3", role: "reasoning" });
    const olderPlan = row("older-plan", "t-1", "turn.plan.updated", { plan: [] });
    const items = [...t.items.slice(0, 4), olderPlan, ...t.items.slice(4, 8), plan, thinking, ...t.items.slice(8)];
    const kept = trimToWireWindow(items, cutOf(t), everyRowBelow);
    assert.ok(kept?.includes(plan), "the plan checklist still has its plan");
    assert.ok(kept?.includes(thinking));
    assert.ok(!kept?.includes(olderPlan));
  });

  it("never keeps a lone request row as the newest of its kind: a resolved request goes as a pair", () => {
    const t = long();
    // The thread's only approval, resolved in an old turn: kept alone, its `*.requested` row
    // would re-derive as pending on the client.
    const asked = row("asked", "t-2", "approval.requested", { requestId: "a-1" });
    const answered = row("answered", "t-2", "approval.resolved", { requestId: "a-1" });
    const kept = trimToWireWindow([...t.items.slice(0, 8), asked, answered, ...t.items.slice(8)], cutOf(t), everyRowBelow);
    assert.ok(kept && !kept.includes(asked) && !kept.includes(answered));
  });

  it("keeps the newest plan proposal only while nothing implemented it, with the deltas that hold its text", () => {
    const t = long();
    const plan = row("plan-2", "t-2", "turn.proposed.completed", {});
    const deltas = [
      row("delta-a", "t-2", "turn.proposed.delta", { delta: "# Plan\n" }),
      row("delta-b", "t-2", "turn.proposed.delta", { delta: "step one" })
    ];
    const withPlan = [...t.items.slice(0, 4), ...t.items.slice(4, 8), ...deltas, plan, ...t.items.slice(8)];
    const open = trimToWireWindow(withPlan, cutOf(t), everyRowBelow);
    assert.ok(open?.includes(plan), "not implemented: the composer still offers it");
    assert.ok(deltas.every((delta) => open?.includes(delta)), "its text streamed: its deltas stay with it");
    // The next turn's prompt implemented it: kept, the plan would read as not implemented.
    const implementing = { ...prompt(3), text: "PLEASE IMPLEMENT THIS PLAN:\n# Plan\nstep one", createdAt: "2026-10-24T00:00:01.000Z" };
    const plan2 = { ...plan, createdAt: AT };
    const implemented = withPlan.map((item) => (item.id === "user:t-3" ? implementing : item === plan ? plan2 : item));
    const gone = trimToWireWindow(implemented, cutOf(t), everyRowBelow);
    assert.ok(gone && !gone.includes(plan2) && !gone.includes(implementing));
    assert.ok(!deltas.some((delta) => gone.includes(delta)));
  });

  it("drops a call whole or keeps it whole", () => {
    const t = long();
    // Call 2's close is written in a kept turn's place: the whole call stays.
    const lateClose = row("call-2:late", "t-14", "tool.completed", { toolUseId: "call-2" });
    const kept = trimToWireWindow([...t.items, lateClose], cutOf(t), everyRowBelow);
    assert.ok(kept);
    assert.ok(["call-2:start", "call-2:done", "call-2:late"].every((id) => kept.some((item) => item.id === id)));
    assert.ok(!kept.some((item) => item.id === "call-3:start"));
  });
});
