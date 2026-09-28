import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ThreadPromptEntry } from "@orquester/api/agent-chat";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "@orquester/api/agent-chat";

import { activity, foldTurn, historyPage, message, resetBuilders, stamp } from "../agent-chat/test-helpers";
import {
  createLoadedPromptsMemo,
  filterPromptsBySearch,
  mergeHistoryPrompts,
  type HistoryPrompt,
  type LoadedPromptsInput
} from "./prompts.logic";

beforeEach(() => resetBuilders());

function input(overrides: Partial<LoadedPromptsInput>): LoadedPromptsInput {
  return { pages: [], bridge: [], entries: [], turns: [], ...overrides };
}

function entry(
  messageId: string,
  createdAt: string,
  overrides: Partial<ThreadPromptEntry> = {}
): ThreadPromptEntry {
  return {
    messageId,
    turnId: null,
    turnOrdinal: null,
    rewindable: null,
    text: `index ${messageId}`,
    truncated: false,
    createdAt,
    seq: 0,
    ...overrides
  };
}

function ids(prompts: readonly HistoryPrompt[]): string[] {
  return prompts.map((prompt) => prompt.messageId);
}

describe("prompt turn numbering", () => {
  it("numbers opening prompts by started turns and keeps the first claim", () => {
    const result = createLoadedPromptsMemo()(input({
      entries: [
        message("user", "first", { id: "u1" }),
        message("user", "later", { id: "u3" }),
        message("user", "pending", { id: "u-pending" })
      ],
      turns: [
        foldTurn("t1", "u1"),
        foldTurn(null, "u-pending"),
        foldTurn("t2"),
        foldTurn("t3", "u3"),
        foldTurn("t4", "u1")
      ]
    }));
    assert.deepEqual(result.prompts.map(({ messageId, turnId, turnOrdinal }) => [messageId, turnId, turnOrdinal]), [
      ["u-pending", null, null],
      ["u3", "t3", 3],
      ["u1", "t1", 1]
    ]);
  });
});

describe("loaded history prompts", () => {
  it("walks the pages, the bridge, then the window — parent user messages only, once each", () => {
    const pageOnly = message("user", "from a page", { id: "p1" });
    const shared = message("user", "on a page and in the window", { id: "s1" });
    const bridged = message("user", "in the bridge", { id: "b1" });
    const windowCopy = { ...shared, text: "edited prompt", updatedAt: stamp(99) };
    const own = message("user", "window only", { id: "w1" });
    const result = createLoadedPromptsMemo()(input({
      pages: [historyPage({ items: [pageOnly, shared, message("assistant", "an answer")] })],
      bridge: [bridged, activity("tool.completed", {})],
      entries: [
        windowCopy,
        message("user", "a subagent's prompt", { agentId: "agent-1" }),
        message("reasoning", "thinking"),
        own
      ]
    }));
    assert.deepEqual(ids(result.prompts), ["w1", "b1", "s1", "p1"]);
    assert.equal(result.prompts[2]!.text, "edited prompt");
  });
});

describe("createLoadedPromptsMemo", () => {
  it("lists the parent's reusable prompts newest first, with the turn each one started", () => {
    const memo = createLoadedPromptsMemo();
    const result = memo(
      input({
        entries: [
          message("user", "  first prompt  ", { id: "u1" }),
          message("assistant", "ok", { turnId: "t1" }),
          message("user", "a steer", { id: "u2", turnId: "t1" }),
          message("user", "second prompt [Image #1]", { id: "u3" }),
          message("user", "subagent prompt", { id: "u4", agentId: "a1" }),
          message("user", "not started yet", { id: "u5" })
        ],
        turns: [foldTurn("t1", "u1"), foldTurn("t2", "u3"), foldTurn(null, "u5")]
      })
    );
    assert.deepEqual(ids(result.prompts), ["u5", "u3", "u2", "u1"]);
    const [pending, second, steer, first] = result.prompts;
    assert.deepEqual(
      [first!.text, first!.turnId, first!.turnOrdinal, first!.source, first!.truncated],
      ["first prompt", "t1", 1, "loaded", false]
    );
    // The image placeholder goes: reuse is text-only.
    assert.deepEqual([second!.text, second!.turnId, second!.turnOrdinal], ["second prompt", "t2", 2]);
    // A steer rides the turn another prompt opened.
    assert.deepEqual([steer!.turnId, steer!.turnOrdinal], ["t1", null]);
    assert.deepEqual([pending!.turnId, pending!.turnOrdinal], [null, null]);
  });

  it("leaves out what nobody typed, and says what it was", () => {
    const memo = createLoadedPromptsMemo();
    const result = memo(
      input({
        entries: [
          message("user", "<task-notification>done</task-notification>", { id: "internal" }),
          message("user", "/compact", { id: "compact" }),
          message("user", `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`, { id: "plan" }),
          message("user", "[Image #1]", { id: "image" }),
          message("user", "real", { id: "real" })
        ]
      })
    );
    assert.deepEqual(ids(result.prompts), ["real"]);
    assert.deepEqual(Object.fromEntries(result.unlisted), {
      internal: "agent",
      compact: "other",
      plan: "plan",
      image: "other"
    });
  });

  it("numbers a pending prompt when its turn starts", () => {
    const memo = createLoadedPromptsMemo();
    const u1 = message("user", "one", { id: "u1" });
    const u2 = message("user", "two", { id: "u2" });
    const after = memo(input({ entries: [u1, u2], turns: [foldTurn("t1", "u1"), foldTurn(null, "u2")] }));
    assert.equal(after.prompts[0]!.turnOrdinal, null);
    const started = memo(input({ entries: [u1, u2], turns: [foldTurn("t1", "u1"), foldTurn("t2", "u2")] }));
    assert.equal(started.prompts[0]!.turnOrdinal, 2, "the turn started: the prompt is numbered");
  });
});

describe("mergeHistoryPrompts", () => {
  function loaded(messageId: string, createdAt: string, turnId: string | null = null): HistoryPrompt {
    return {
      messageId,
      text: `loaded ${messageId}`,
      truncated: false,
      turnId,
      turnOrdinal: null,
      createdAt,
      source: "loaded",
      indexRewindable: null
    };
  }

  it("keeps the chat's copy of a prompt both hold, and adds what only the index has below it", () => {
    const merged = mergeHistoryPrompts(
      [loaded("u3", stamp(30)), loaded("u2", stamp(20))],
      [
        entry("u3", stamp(30), { text: "cut…", truncated: true }),
        entry("u2", stamp(20)),
        entry("u1", stamp(10), { turnId: "t1", turnOrdinal: 1, rewindable: true })
      ],
      null
    );
    assert.deepEqual(ids(merged), ["u3", "u2", "u1"]);
    assert.deepEqual([merged[0]!.source, merged[0]!.text, merged[0]!.truncated], ["loaded", "loaded u3", false]);
    assert.deepEqual(
      [merged[2]!.source, merged[2]!.turnOrdinal, merged[2]!.indexRewindable],
      ["index", 1, true]
    );
  });

  it("drops an index entry whose turn the fold no longer knows — a rewind removed it", () => {
    const merged = mergeHistoryPrompts(
      [],
      [
        entry("gone", stamp(40), { turnId: "t-reverted", turnOrdinal: 4 }),
        entry("kept", stamp(30), { turnId: "t3", turnOrdinal: 3 }),
        entry("unclaimed", stamp(20))
      ],
      new Set(["t3"])
    );
    assert.deepEqual(ids(merged), ["kept", "unclaimed"]);
    // Without a snapshot there is nothing to judge by: everything stays.
    assert.equal(mergeHistoryPrompts([], [entry("gone", stamp(1), { turnId: "tx" })], null).length, 1);
  });

  it("merges by time, newest first, each list keeping its own order; a tie keeps the loaded prompt first", () => {
    const merged = mergeHistoryPrompts(
      // Log order, even where two stamps disagree with it.
      [loaded("w3", stamp(50)), loaded("w2", stamp(52)), loaded("w1", stamp(30))],
      [entry("i-new", stamp(60)), entry("i-tie", stamp(30)), entry("i-old", stamp(10))],
      null
    );
    assert.deepEqual(ids(merged), ["i-new", "w3", "w2", "w1", "i-tie", "i-old"]);
  });

  it("lists an index prompt once even when two pages carried it", () => {
    const shared = entry("u1", stamp(10));
    const first = mergeHistoryPrompts([], [shared, { ...shared }], null);
    assert.deepEqual(ids(first), ["u1"]);
  });
});

describe("search", () => {
  const prompts: HistoryPrompt[] = [
    ["a", "Fix the CAFÉ menu layout"],
    ["b", "Refactor the auth flow"],
    ["c", "Write the ﬁle upload test"]
  ].map(([messageId, text]) => ({
    messageId: messageId!,
    text: text!,
    truncated: false,
    turnId: null,
    turnOrdinal: null,
    createdAt: stamp(1),
    source: "loaded" as const,
    indexRewindable: null
  }));

  it("needs every word, in any order", () => {
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "menu cafe")), ["a"]);
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "the")), ["a", "b", "c"]);
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "auth menu")), []);
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "FILE")), ["c"]);
  });

  it("shows all prompts for a blank query", () => {
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "   ")), ["a", "b", "c"]);
  });
});
