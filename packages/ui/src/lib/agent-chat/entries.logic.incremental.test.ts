/**
 * The timeline layer's memoised paths (`deriveTimelineEntriesFromItems` fed
 * its previous projection) answer exactly what a cold derivation of the same
 * items does: the streamed-text path, the appended-activity path, the work
 * rows' per-activity facts and their merged rows' memo. A scripted thread is
 * grown one fold-shaped change at a time — appends, streamed tokens, rows
 * replaced in place, rows evicted at the head — and at every step the warm
 * projection is compared with one derived from a deep copy of the items, which
 * no memo has ever seen.
 */

import type { ThreadActivityItem, ThreadItem, ThreadMessageItem } from "@orquester/api/agent-chat";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveTimelineEntriesFromItems,
  itemsForAgent,
  type ThreadTimelineProjection
} from "./entries.logic";
import { stamp } from "./test-helpers";

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

const view = (projection: ThreadTimelineProjection) => ({
  entries: projection.entries,
  messages: projection.messages,
  workEntries: projection.workEntries,
  proposedPlans: projection.proposedPlans,
  activities: projection.activities
});

/** One scripted thread's items after each change, as the fold would hand them over. */
function scriptedThread(seed: number, steps: number): ThreadItem[][] {
  const next = random(seed);
  let items: ThreadItem[] = [];
  const history: ThreadItem[][] = [];
  let clock = 0;
  let id = 0;
  let turn = 1;
  const at = (): string => {
    // Now and then two rows share a timestamp: the sort's tie order is part of what is compared.
    if (next() > 0.15) clock += 1;
    return stamp(clock);
  };
  const owner = (): string | undefined => pick(next, [undefined, undefined, undefined, "agent-1", "agent-2"]);
  const activityRow = (activityKind: string, payload: Record<string, unknown>, agentId?: string): ThreadActivityItem => {
    const createdAt = at();
    return {
      kind: "activity",
      id: `a${++id}`,
      tone: activityKind.startsWith("task.") ? "info" : "tool",
      activityKind,
      summary: activityKind,
      payload,
      turnId: next() > 0.1 ? `t${turn}` : null,
      createdAt,
      updatedAt: createdAt,
      ...(agentId !== undefined ? { agentId } : {})
    };
  };
  const messageRow = (role: ThreadMessageItem["role"], text: string, streaming: boolean, agentId?: string): ThreadMessageItem => {
    const createdAt = at();
    return {
      kind: "message",
      id: `m${++id}`,
      role,
      text,
      turnId: role === "user" ? null : `t${turn}`,
      streaming,
      createdAt,
      updatedAt: createdAt,
      ...(agentId !== undefined ? { agentId } : {})
    };
  };
  const push = (...rows: ThreadItem[]): void => {
    items = [...items, ...rows];
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    const call = `call-${Math.floor(next() * 6)}`;
    if (roll < 0.3) {
      const kind = pick(next, ["tool.started", "tool.updated", "tool.completed", "tool.denied", "tool.output", "tool.output"]);
      const payload: Record<string, unknown> = {
        toolUseId: call,
        itemType: pick(next, ["command_execution", "file_change", "mcp_tool_call"]),
        title: pick(next, ["Command run", "Edit", "Read file"]),
        ...(kind === "tool.output"
          ? { streamKind: pick(next, ["command_output", "file_change_output"]), delta: `line ${step}\n` }
          : { detail: pick(next, ["ls", "exit code 1", "ok", "No such file or directory"]), status: pick(next, ["inProgress", "completed", "failed"]) }),
        ...(next() > 0.6 ? { command: `cmd ${call}` } : {})
      };
      const who = kind === "tool.output" && next() > 0.5 ? undefined : owner();
      // An owner rides the row or, as some adapters write it, the payload.
      if (who !== undefined && next() > 0.5) {
        push(activityRow(kind, { ...payload, agentId: who }));
      } else {
        push(activityRow(kind, payload, who));
      }
    } else if (roll < 0.45) {
      // A streamed token: the last streaming message's text grows in place, or the message ends.
      let at = items.length - 1;
      while (at >= 0 && !(items[at]!.kind === "message" && (items[at] as ThreadMessageItem).streaming)) at -= 1;
      if (at === -1) {
        push(messageRow(pick(next, ["assistant", "reasoning"]), "", true, next() > 0.8 ? "agent-1" : undefined));
      } else {
        const streaming = items[at] as ThreadMessageItem;
        const ends = next() > 0.85;
        // An answer can end as a word-for-word copy of its turn's opening one (a re-emitted copy).
        const opening = items.find(
          (item) =>
            item.kind === "message" &&
            item.role === "assistant" &&
            item.turnId === streaming.turnId &&
            !item.streaming &&
            item.agentId === streaming.agentId
        ) as ThreadMessageItem | undefined;
        const grown: ThreadMessageItem = {
          ...streaming,
          text: ends && opening !== undefined && next() > 0.3
            ? opening.text
            : ends && next() > 0.5
              ? streaming.text
              : `${streaming.text}tok${step} `,
          streaming: !ends,
          updatedAt: stamp(clock)
        };
        items = items.map((item, index) => (index === at ? grown : item));
      }
    } else if (roll < 0.53) {
      turn += next() > 0.5 ? 1 : 0;
      push(messageRow("user", next() > 0.9 ? `PLEASE IMPLEMENT THIS PLAN:\nplan ${step}` : `prompt ${step}`, false));
    } else if (roll < 0.6) {
      // A finished answer, now and then repeating the turn's first word for word (a re-emitted copy).
      const opening = items.find((item) => item.kind === "message" && item.role === "assistant" && item.turnId === `t${turn}` && !item.streaming);
      push(messageRow("assistant", opening !== undefined && next() > 0.5 ? (opening as ThreadMessageItem).text : `answer ${step}`, false));
    } else if (roll < 0.72) {
      const agent = pick(next, ["agent-1", "agent-2", "wf:1"]);
      push(
        activityRow(
          pick(next, ["task.started", "task.progress", "task.completed", "task.updated"]),
          {
            taskId: agent === "wf:1" ? "wf-run:wf:1" : agent,
            agentKind: pick(next, ["agent", "agent", "background"]),
            toolUseId: `launch-${agent}`,
            status: pick(next, ["running", "completed"]),
            summary: `progress ${step}`
          },
          next() > 0.5 ? agent : undefined
        )
      );
    } else if (roll < 0.76) {
      push(
        next() > 0.5
          ? activityRow("turn.proposed.delta", { delta: `step ${step} ` })
          : activityRow("turn.proposed.completed", next() > 0.5 ? { planMarkdown: `plan ${step}` } : {})
      );
    } else if (roll < 0.82) {
      push(
        activityRow(
          pick(next, ["hook.started", "hook.completed", "context-window.updated", "runtime.warning", "goal.updated"]),
          { outcome: pick(next, ["success", "error"]), usedTokens: step }
        )
      );
    } else if (roll < 0.9 && items.length > 0) {
      // The fold rewrites a row in place (a newer copy of the same activity).
      const at = Math.floor(next() * items.length);
      const row = items[at]!;
      if (row.kind === "activity") {
        const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
        const rewritten: ThreadActivityItem = { ...row, payload: { ...payload, status: "completed" }, updatedAt: stamp(clock) };
        items = items.map((item, index) => (index === at ? rewritten : item));
      }
    } else if (items.length > 0) {
      // Retention evicts the oldest row.
      items = items.slice(1);
    }
    history.push(items);
  }
  return history;
}

describe("the timeline layer's memoised paths match a cold derivation", () => {
  for (const seed of [1, 7, 42, 1234]) {
    it(`a scripted thread, seed ${seed}: the parent view, repaired and not, and each agent's drill-in`, () => {
      const steps = scriptedThread(seed, 400);
      const views: { options?: { ownerAgentId?: string; dropRepeatedAssistantMessages?: boolean }; select: (items: ThreadItem[]) => ThreadItem[] }[] = [
        { select: (items) => items },
        { options: { dropRepeatedAssistantMessages: true }, select: (items) => items },
        { options: { ownerAgentId: "agent-1" }, select: (items) => itemsForAgent(items, "agent-1") },
        { options: { ownerAgentId: "agent-2" }, select: (items) => itemsForAgent(items, "agent-2") }
      ];
      for (const { options, select } of views) {
        let warm: ThreadTimelineProjection | null = null;
        for (const [index, items] of steps.entries()) {
          const input = options?.ownerAgentId === undefined ? items : select(items);
          warm = deriveTimelineEntriesFromItems(input, warm, options);
          const cold = deriveTimelineEntriesFromItems(structuredClone(input), null, options);
          assert.deepEqual(view(warm), view(cold), `step ${index} of ${JSON.stringify(options ?? {})}`);
        }
      }
    });
  }

  it("a streamed answer that ends as a copy of its turn's opening one leaves the streamed-text path", () => {
    const row = (id: string, text: string, streaming: boolean, n: number): ThreadMessageItem => ({
      kind: "message",
      id,
      role: "assistant",
      text,
      turnId: "t1",
      streaming,
      createdAt: stamp(n),
      updatedAt: stamp(n)
    });
    const opening = row("m1", "Done.", false, 1);
    const options = { dropRepeatedAssistantMessages: true };
    let warm = deriveTimelineEntriesFromItems([opening, row("m2", "Do", true, 2)], null, options);
    warm = deriveTimelineEntriesFromItems([opening, row("m2", "Done.", true, 2)], warm, options);
    const ended = [opening, row("m2", "Done.", false, 2)];
    warm = deriveTimelineEntriesFromItems(ended, warm, options);
    assert.deepEqual(warm.messages.map((message) => message.id), ["m1"], "the finished copy is dropped");
    assert.deepEqual(view(warm), view(deriveTimelineEntriesFromItems(structuredClone(ended), null, options)));
  });

  it("an appended activity keeps every merged row before it the same object", () => {
    const start: ThreadActivityItem = {
      kind: "activity",
      id: "u1",
      tone: "tool",
      activityKind: "tool.updated",
      summary: "Command run",
      payload: { toolUseId: "c1", itemType: "command_execution", title: "Command run", status: "inProgress", detail: "ls" },
      turnId: "t1",
      createdAt: stamp(1),
      updatedAt: stamp(1)
    };
    const done: ThreadActivityItem = { ...start, id: "u2", activityKind: "tool.completed", payload: { ...(start.payload as object), status: "completed" }, createdAt: stamp(2), updatedAt: stamp(2) };
    const spawn = (n: number, taskId: string): ThreadActivityItem => ({
      kind: "activity",
      id: `s${n}`,
      tone: "info",
      activityKind: n === 1 ? "task.started" : "task.progress",
      summary: "Agent",
      payload: { taskId, agentKind: "agent", toolUseId: `launch-${taskId}` },
      turnId: "t1",
      createdAt: stamp(2 + n),
      updatedAt: stamp(2 + n)
    });
    const window = [start, done, spawn(1, "a1"), spawn(2, "a2")];
    const first = deriveTimelineEntriesFromItems(window);
    assert.equal(first.workEntries.length, 2, "one call row and one spawn row");
    const later: ThreadActivityItem = { ...start, id: "u3", payload: { toolUseId: "c2", itemType: "command_execution", title: "Command run" }, createdAt: stamp(9), updatedAt: stamp(9) };
    const second = deriveTimelineEntriesFromItems([...window, later], first);
    assert.equal(second.workEntries[0], first.workEntries[0], "the collapsed call row");
    assert.equal(second.workEntries[1], first.workEntries[1], "the spawn row");
    assert.equal(second.entries[0], first.entries[0], "and so its timeline entry");
  });
});
