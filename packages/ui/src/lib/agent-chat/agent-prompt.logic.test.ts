/**
 * An agent's launch prompt in its drill-in (§7.6, "its prompt at the top").
 *
 * The prompt rides the agent's `task.started` as `payload.prompt` (the prompt
 * task's interface: verbatim, bounded at rest with `promptTruncated`, cut on
 * the wire with the item's `truncated`); these rows are hand-built to carry
 * it. The client never invents one: no prompt on the start, no row.
 */

import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import type { ThreadItem,ThreadMessageItem } from "@orquester/api/agent-chat";

import { agentPromptOf,drillInWindow } from "./agent-prompt.logic";
import { activity,message,resetBuilders,stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

/** A launch of `taskId`, as ingestion writes it; `owner` stamps the row (Claude's is the parent's: none). */
function launch(
  taskId: string,
  extra: Record<string, unknown>,
  overrides: { id: string; at: number; owner?: string }
): ThreadItem {
  return activity(
    "task.started",
    { taskId, agentKind: "agent", taskType: "subagent", title: "Find callers", ...extra },
    {
      id: overrides.id,
      tone: "info",
      turnId: "t1",
      createdAt: stamp(overrides.at),
      ...(overrides.owner !== undefined ? { agentId: overrides.owner } : {})
    }
  );
}

const prompts = (items: readonly ThreadItem[]): ThreadMessageItem[] =>
  items.filter((item): item is ThreadMessageItem => item.kind === "message" && agentPromptOf(item) !== null);

describe("drillInWindow: the agent's own items, each launch's prompt at its place", () => {
  it("puts a Claude launch's prompt — a PARENT row — before the agent's own rows", () => {
    const items: ThreadItem[] = [
      message("user", "Find the callers of parse()", { id: "u1", createdAt: stamp(0) }),
      launch("a1", { prompt: "Find every caller of parse() and list them.", toolUseId: "call-agent" }, { id: "start", at: 1 }),
      message("assistant", "Looking.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(2) })
    ];
    const drill = drillInWindow(items, "a1").items;
    assert.deepEqual(
      drill.map((item) => item.id),
      ["agent-prompt:start", "said"],
      "the parent's own rows stay the parent's; the launch row itself is not the agent's"
    );
    const [prompt] = prompts(drill);
    assert.ok(prompt);
    assert.equal(prompt.role, "user", "it reads as the agent's user turn");
    assert.equal(prompt.text, "Find every caller of parse() and list them.");
    assert.equal(prompt.agentId, "a1", "an agent-owned message, so the drill-in keeps it");
    assert.equal(prompt.createdAt, stamp(1), "at its launch");
    assert.deepEqual(agentPromptOf(prompt), { itemId: "start", truncated: false, cutAtRest: false });
  });

  it("keeps a launch the agent's own row stamps (Codex, OpenCode, Grok), the prompt first", () => {
    const items: ThreadItem[] = [launch("a1", { prompt: "Explore the repo." }, { id: "start", at: 1, owner: "a1" })];
    assert.deepEqual(
      drillInWindow(items, "a1").items.map((item) => item.id),
      ["agent-prompt:start", "start"]
    );
  });

  it("invents nothing: a launch with no prompt, a blank one, or another agent's adds no row", () => {
    const items: ThreadItem[] = [
      launch("a1", {}, { id: "none", at: 1 }),
      launch("a1", { prompt: "   " }, { id: "blank", at: 2 }),
      launch("a2", { prompt: "Not yours." }, { id: "other", at: 3 })
    ];
    assert.deepEqual(prompts(drillInWindow(items, "a1").items), []);
  });

  it("a relaunch's prompt heads its run: one row per launch, at its place", () => {
    const items: ThreadItem[] = [
      launch("a1", { prompt: "First task.", toolUseId: "call-1" }, { id: "first", at: 1 }),
      message("assistant", "Done once.", { id: "once", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
      launch("a1", { prompt: "Now the second.", toolUseId: "call-2" }, { id: "again", at: 3 }),
      message("assistant", "Done twice.", { id: "twice", agentId: "a1", turnId: "t1", createdAt: stamp(4) })
    ];
    assert.deepEqual(
      drillInWindow(items, "a1").items.map((item) => item.id),
      ["agent-prompt:first", "once", "agent-prompt:again", "twice"]
    );
  });

  it("a launch delivered twice is one prompt: the first start of a launch wins", () => {
    const items: ThreadItem[] = [
      launch("a1", { prompt: "The task.", toolUseId: "call-1" }, { id: "first", at: 1 }),
      launch("a1", { prompt: "The task.", toolUseId: "call-1" }, { id: "late", at: 5 })
    ];
    assert.deepEqual(prompts(drillInWindow(items, "a1").items).map((prompt) => prompt.id), ["agent-prompt:first"]);
  });

  it("a re-emitted start with NO launch id is still one prompt: keyed by what the start says", () => {
    const items: ThreadItem[] = [
      launch("a1", { prompt: "The task." }, { id: "first", at: 1 }),
      launch("a1", { prompt: "The task." }, { id: "again", at: 5 })
    ];
    assert.deepEqual(prompts(drillInWindow(items, "a1").items).map((prompt) => prompt.id), ["agent-prompt:first"]);
  });

  it("two starts with no launch id that say different things are two prompts", () => {
    const items: ThreadItem[] = [
      launch("a1", { prompt: "First task." }, { id: "first", at: 1 }),
      launch("a1", { prompt: "Second task." }, { id: "second", at: 5 })
    ];
    assert.deepEqual(prompts(drillInWindow(items, "a1").items).map((prompt) => prompt.id), [
      "agent-prompt:first",
      "agent-prompt:second"
    ]);
  });

  it("says what the log kept: cut on the wire (the item holds all of it), or cut at rest", () => {
    const items: ThreadItem[] = [
      launch("a1", { prompt: "A long prompt…", truncated: true }, { id: "wire", at: 1 }),
      launch("a1", { prompt: "The start of it", promptTruncated: true, toolUseId: "call-2" }, { id: "rest", at: 2 })
    ];
    const [wire, rest] = prompts(drillInWindow(items, "a1").items);
    assert.deepEqual(agentPromptOf(wire!), { itemId: "wire", truncated: true, cutAtRest: false });
    assert.deepEqual(agentPromptOf(rest!), { itemId: "rest", truncated: false, cutAtRest: true });
  });
});

describe("drillInWindow: latest launch", () => {

  it("names the agent's latest launch too — any start naming it, with a prompt or not", () => {
    const items: ThreadItem[] = [
      launch("a1", { prompt: "First." }, { id: "first", at: 1 }),
      message("assistant", "Done.", { id: "said", agentId: "a1", turnId: "t1", createdAt: stamp(2) }),
      launch("a1", { toolUseId: "call-2" }, { id: "again", at: 7 }),
      launch("a2", { prompt: "Not yours." }, { id: "other", at: 9 })
    ];
    const window = drillInWindow(items, "a1");
    assert.equal(window.latestLaunchAt, stamp(7));
    assert.deepEqual(window.items.map((item) => item.id), ["agent-prompt:first", "said"]);
  });
});
