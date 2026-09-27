import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ThreadPromptEntry } from "@orquester/api/agent-chat";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "@orquester/api/agent-chat";

import { activity, foldTurn, historyPage, message, resetBuilders, stamp } from "../agent-chat/test-helpers";
import {
  createLoadedPromptsMemo,
  filterPromptsBySearch,
  foldSearchText,
  knownTurnIdsOf,
  loadedUserMessages,
  mergeHistoryPrompts,
  promptTurnClaims,
  searchTermsOf,
  turnOrdinalsOf,
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

describe("promptTurnClaims", () => {
  it("numbers the turn each prompt opened by its position among the STARTED turns", () => {
    const claims = promptTurnClaims([
      foldTurn("t1", "u1"),
      foldTurn(null, "u-pending"), // never started: no ordinal, no claim
      foldTurn("t2"), // started by the agent: claims nothing, still counts
      foldTurn("t3", "u3")
    ]);
    assert.deepEqual(claims.get("u1"), { turnId: "t1", ordinal: 1 });
    assert.deepEqual(claims.get("u3"), { turnId: "t3", ordinal: 3 });
    assert.equal(claims.has("u-pending"), false);
  });

  it("lets the first turn win when one prompt names two", () => {
    const claims = promptTurnClaims([foldTurn("t1", "u1"), foldTurn("t2", "u1")]);
    assert.deepEqual(claims.get("u1"), { turnId: "t1", ordinal: 1 });
  });

  it("counts a replayed turn id once, like `startedTurns`", () => {
    const claims = promptTurnClaims([foldTurn("t1", "u1"), foldTurn("t1", "u1"), foldTurn("t2", "u2")]);
    assert.deepEqual(claims.get("u2"), { turnId: "t2", ordinal: 2 });
    assert.equal(turnOrdinalsOf([foldTurn("t1"), foldTurn("t1"), foldTurn("t2")]).get("t2"), 2);
  });

  it("knows every turn id the fold holds, pending rows aside", () => {
    assert.deepEqual([...knownTurnIdsOf([foldTurn("t1"), foldTurn(null), foldTurn("t2")])], ["t1", "t2"]);
  });
});

describe("loadedUserMessages", () => {
  it("walks the pages, the bridge, then the window — parent user messages only, once each", () => {
    const pageOnly = message("user", "from a page", { id: "p1" });
    const shared = message("user", "on a page and in the window", { id: "s1" });
    const bridged = message("user", "in the bridge", { id: "b1" });
    const windowCopy = { ...shared, updatedAt: stamp(99) };
    const own = message("user", "window only", { id: "w1" });
    const messages = loadedUserMessages({
      pages: [historyPage({ items: [pageOnly, shared, message("assistant", "an answer")] })],
      bridge: [bridged, activity("tool.completed", {})],
      entries: [
        windowCopy,
        message("user", "a subagent's prompt", { agentId: "agent-1" }),
        message("reasoning", "thinking"),
        own
      ]
    });
    assert.deepEqual(
      messages.map((item) => item.id),
      ["p1", "s1", "b1", "w1"]
    );
    // Listed at its OLDEST place, with the newest copy.
    assert.equal(messages[1], windowCopy);
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

  it("hands the same list back while only the rest of the window streams", () => {
    const memo = createLoadedPromptsMemo();
    const u1 = message("user", "prompt", { id: "u1" });
    const turns = [foldTurn("t1", "u1")];
    const first = memo(input({ entries: [u1, message("assistant", "Wor", { id: "a1", streaming: true })], turns }));
    const second = memo(
      input({ entries: [u1, message("assistant", "Working on it", { id: "a1", streaming: true })], turns })
    );
    assert.equal(second, first, "a streamed token moves nothing the panel shows");
    // A new turns array with the same claims keeps the list too.
    const third = memo(input({ entries: [u1], turns: [...turns] }));
    assert.equal(third.prompts, first.prompts);
    assert.equal(third, first);
  });

  it("walks the loaded history only when its arrays change — per token, only the window", () => {
    const memo = createLoadedPromptsMemo();
    let reads = 0;
    // Counts every read of the page's items, however the walk reaches them.
    const counted = <T extends object>(list: T[]): T[] =>
      new Proxy(list, {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver);
        }
      });
    const pages = [historyPage({ items: counted([message("user", "from a page", { id: "p1" })]) })];
    const bridge = counted([message("user", "in the bridge", { id: "b1" })]);
    const u1 = message("user", "live", { id: "u1" });
    const turns = [foldTurn("t1", "u1")];
    const first = memo(input({ pages, bridge, entries: [u1, message("assistant", "a", { id: "a1" })], turns }));
    assert.deepEqual(ids(first.prompts), ["u1", "b1", "p1"]);
    const afterFirst = reads;
    assert.ok(afterFirst > 0);
    const second = memo(input({ pages, bridge, entries: [u1, message("assistant", "ab", { id: "a1" })], turns }));
    assert.equal(second, first);
    assert.equal(reads, afterFirst, "a streamed token re-reads no page and no bridge row");
    const bridged = memo(input({ pages, bridge: [...bridge, message("user", "evicted", { id: "b2" })], entries: [u1], turns }));
    assert.deepEqual(ids(bridged.prompts), ["u1", "b2", "b1", "p1"], "a new bridge array is read again");
  });

  it("reuses every unchanged prompt object when one is added, and renumbers on a new claim", () => {
    const memo = createLoadedPromptsMemo();
    const u1 = message("user", "one", { id: "u1" });
    const u2 = message("user", "two", { id: "u2" });
    const before = memo(input({ entries: [u1], turns: [foldTurn("t1", "u1")] }));
    const after = memo(input({ entries: [u1, u2], turns: [foldTurn("t1", "u1"), foldTurn(null, "u2")] }));
    assert.notEqual(after.prompts, before.prompts);
    assert.equal(after.prompts[1], before.prompts[0], "u1 keeps its object");
    assert.equal(after.prompts[0]!.turnOrdinal, null);
    const started = memo(input({ entries: [u1, u2], turns: [foldTurn("t1", "u1"), foldTurn("t2", "u2")] }));
    assert.equal(started.prompts[0]!.turnOrdinal, 2, "the turn started: the prompt is numbered");
    assert.equal(started.prompts[1], before.prompts[0]);
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
    // Deterministic.
    assert.deepEqual(
      ids(
        mergeHistoryPrompts(
          [loaded("w3", stamp(50)), loaded("w2", stamp(52)), loaded("w1", stamp(30))],
          [entry("i-new", stamp(60)), entry("i-tie", stamp(30)), entry("i-old", stamp(10))],
          null
        )
      ),
      ids(merged)
    );
  });

  it("lists an index prompt once even when two pages carried it, and keeps its row object", () => {
    const shared = entry("u1", stamp(10));
    const first = mergeHistoryPrompts([], [shared, { ...shared }], null);
    assert.deepEqual(ids(first), ["u1"]);
    const second = mergeHistoryPrompts([], [shared], null);
    assert.equal(second[0], first[0]);
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

  it("folds case, diacritics and compatibility forms", () => {
    assert.equal(foldSearchText("Café ÉCOLE ﬁle"), "cafe ecole file");
    assert.deepEqual(searchTermsOf("  Café   menu "), ["cafe", "menu"]);
  });

  it("needs every word, in any order", () => {
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "menu cafe")), ["a"]);
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "the")), ["a", "b", "c"]);
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "auth menu")), []);
    assert.deepEqual(ids(filterPromptsBySearch(prompts, "FILE")), ["c"]);
  });

  it("hands the list back for a blank query", () => {
    assert.equal(filterPromptsBySearch(prompts, "   "), prompts);
  });
});
