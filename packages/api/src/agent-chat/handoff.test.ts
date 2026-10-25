/**
 * "Continue in another agent": the window-sized budget, the anchored selection — the original
 * request and the newest messages, long anchors cut in the middle, the newest history that fits —
 * the fork point's cut, and the rendering.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  continuationBudgetBytes,
  cutHandoffText,
  escapeForkHandoffTags,
  FORK_HANDOFF_CLOSE_TAG,
  FORK_HANDOFF_OPEN_TAG,
  gitStatusSection,
  HANDOFF_BUDGET_BYTES,
  HANDOFF_BYTES_PER_TOKEN,
  HANDOFF_FALLBACK_CONTEXT_WINDOW,
  HANDOFF_MIN_RESERVE_TOKENS,
  handoffBudgetBytes,
  handoffContextWindow,
  handoffMessagesOf,
  handoffSummaryOf,
  latestContextWindowTokens,
  renderHandoffTranscript,
  retainedTurnsForFork,
  selectHandoffMessages,
  utf8ByteLength,
  utf8Head,
  utf8Tail,
  type HandoffMessage,
  type HandoffSelection
} from "./handoff.ts";
import { startedTurns } from "./turns.ts";
import type { ThreadItem, Turn } from "./thread.ts";

const OVERHEAD = 48;
const MARKER = 64;

function message(id: string, role: "user" | "assistant" | "reasoning", text: string, turnId: string | null, extra: Record<string, unknown> = {}): ThreadItem {
  return { kind: "message", id, role, text, turnId, streaming: false, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", ...extra } as ThreadItem;
}

function turn(turnId: string, userMessageId: string, state: Turn["state"] = "completed"): Turn {
  return { turnId, state, turnCount: null, requestedAt: "x", startedAt: "x", completedAt: "x", assistantMessageId: `a-${turnId}`, userMessageId };
}

/** Three exchanges: u1/a1, u2/a2 (+ reasoning, + a subagent's words), u3/a3. */
function thread(): { turns: Turn[]; items: ThreadItem[] } {
  return {
    turns: [turn("t1", "u1"), turn("t2", "u2"), turn("t3", "u3")],
    items: [
      message("u1", "user", "first question", null),
      message("a-t1", "assistant", "first answer", "t1"),
      message("u2", "user", "second question", null),
      message("r2", "reasoning", "thinking hard", "t2"),
      message("s2", "assistant", "a subagent's report", "t2", { agentId: "agent-1" }),
      message("a-t2", "assistant", "second answer", "t2"),
      message("u3", "user", "third question", null),
      message("a-t3", "assistant", "  third answer  ", "t3")
    ]
  };
}

describe("UTF-8 helpers", () => {
  it("count bytes as UTF-8 does, and cut on character boundaries", () => {
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("é"), 2);
    assert.equal(utf8ByteLength("€"), 3);
    assert.equal(utf8ByteLength("😀"), 4);
    assert.equal(utf8ByteLength("\ud800"), 3, "a lone surrogate is the replacement character");
    for (const text of ["héllo wörld", "a😀b😀c", "€€€€"]) {
      assert.equal(utf8ByteLength(text), Buffer.byteLength(text, "utf8"), text);
      for (let max = 0; max <= utf8ByteLength(text); max += 1) {
        const head = utf8Head(text, max);
        const tail = utf8Tail(text, max);
        assert.ok(utf8ByteLength(head) <= max && text.startsWith(head), `${text} head ${max}`);
        assert.ok(utf8ByteLength(tail) <= max && text.endsWith(tail), `${text} tail ${max}`);
        assert.ok(!/[\ud800-\udbff]$/.test(head) && !/^[\udc00-\udfff]/.test(tail), "never half a pair");
      }
    }
  });
});

describe("handoffMessagesOf", () => {
  it("keeps the main conversation's user and assistant words of the kept turns, in order", () => {
    const { turns, items } = thread();
    const messages = handoffMessagesOf(items, startedTurns(turns));
    assert.deepEqual(messages, [
      { role: "user", text: "first question", turn: 1 },
      { role: "assistant", text: "first answer", turn: 1 },
      { role: "user", text: "second question", turn: 2 },
      { role: "assistant", text: "second answer", turn: 2 },
      { role: "user", text: "third question", turn: 3 },
      { role: "assistant", text: "third answer", turn: 3 }
    ]);
  });

  it("leaves out turns past the cut", () => {
    const { turns, items } = thread();
    const messages = handoffMessagesOf(items, startedTurns(turns).slice(0, 1));
    assert.deepEqual(messages.map((m) => m.text), ["first question", "first answer"]);
  });
});

describe("retainedTurnsForFork (fork at a message)", () => {
  it("a reply keeps its turn, a prompt only the turns before it, nothing named the settled ones", () => {
    const state = thread();
    assert.deepEqual(retainedTurnsForFork(state, { messageId: "a-t2" })?.map((t) => t.turnId), ["t1", "t2"]);
    assert.deepEqual(retainedTurnsForFork(state, { messageId: "u2" })?.map((t) => t.turnId), ["t1"]);
    assert.deepEqual(retainedTurnsForFork(state, {})?.map((t) => t.turnId), ["t1", "t2", "t3"]);
    const running = { ...state, turns: [...state.turns.slice(0, 2), turn("t3", "u3", "running")] };
    assert.deepEqual(retainedTurnsForFork(running, {})?.map((t) => t.turnId), ["t1", "t2"]);
  });

  it("falls back to the client's turn and role for a message out of the window, and gives up on an unknown turn", () => {
    const state = thread();
    assert.deepEqual(retainedTurnsForFork(state, { messageId: "gone", turnId: "t2", role: "user" })?.map((t) => t.turnId), ["t1"]);
    assert.equal(retainedTurnsForFork(state, { messageId: "gone", turnId: "t9", role: "assistant" }), null);
  });

  it("only history up to the fork point reaches the handoff", () => {
    const state = thread();
    const retained = retainedTurnsForFork(state, { messageId: "a-t2" })!;
    const selection = selectHandoffMessages(handoffMessagesOf(state.items, retained));
    assert.deepEqual(selection.messages.map((m) => m.text), ["first question", "first answer", "second question", "second answer"]);
    assert.equal(selection.omitted, 0);
  });
});

describe("handoffBudgetBytes", () => {
  it("sizes the budget from a known window, less the reserve and what else the message carries", () => {
    // 32k window: a 16k reserve (a quarter would be 8k) leaves 16 000 bytes at one byte a token.
    assert.equal(handoffBudgetBytes({ contextWindow: 32_000 }), 16_000);
    assert.equal(handoffBudgetBytes({ contextWindow: 32_000, reservedBytes: 1_000 }), 15_000);
    // 80k window: a quarter (20k) is the reserve.
    assert.equal(handoffBudgetBytes({ contextWindow: 80_000, capBytes: 1_000_000 }), 60_000);
    // A large window is capped at the handoff ceiling.
    assert.equal(handoffBudgetBytes({ contextWindow: 1_000_000 }), HANDOFF_BUDGET_BYTES);
    assert.equal(handoffBudgetBytes({ contextWindow: 1_000_000, capBytes: 120_000 }), 120_000);
  });

  it("assumes the documented fallback window when the target's is unknown", () => {
    const fallback = (HANDOFF_FALLBACK_CONTEXT_WINDOW - Math.max(HANDOFF_MIN_RESERVE_TOKENS, HANDOFF_FALLBACK_CONTEXT_WINDOW / 4)) * HANDOFF_BYTES_PER_TOKEN;
    assert.equal(fallback, 96_000);
    for (const contextWindow of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(handoffBudgetBytes({ contextWindow, capBytes: 1_000_000 }), fallback, String(contextWindow));
      assert.equal(handoffBudgetBytes({ contextWindow }), HANDOFF_BUDGET_BYTES, String(contextWindow));
    }
    assert.equal(handoffBudgetBytes(), HANDOFF_BUDGET_BYTES);
  });

  it("leaves nothing in a tiny window, never a negative budget", () => {
    assert.equal(handoffBudgetBytes({ contextWindow: 8_000 }), 0);
    assert.equal(handoffBudgetBytes({ contextWindow: 16_000 }), 0);
    assert.equal(handoffBudgetBytes({ contextWindow: 17_000 }), 1_000);
    assert.equal(handoffBudgetBytes({ contextWindow: 17_000, reservedBytes: 5_000 }), 0);
  });

  it("reserves a continuation's own words and largest git section", () => {
    assert.equal(continuationBudgetBytes(32_000), 5_760);
    assert.equal(continuationBudgetBytes(undefined), 65_536);
  });
});

describe("handoffContextWindow", () => {
  const reading = (id: string, payload: Record<string, unknown>): ThreadItem =>
    ({ kind: "activity", id, activityKind: "context-window.updated", tone: "info", summary: "", payload, turnId: null, createdAt: "x" }) as unknown as ThreadItem;
  const items = [reading("c1", { usedTokens: 10, maxTokens: 200_000 }), reading("c2", { usedTokens: "bad", maxTokens: 1 })];
  const catalog = [
    { slug: "local/qwen", name: "Qwen", capabilities: null, contextWindow: 32_768 },
    { slug: "gpt-5", name: "GPT-5", capabilities: null }
  ];
  const opus = { model: "opus", options: [{ id: "effort", value: "high" }, { id: "thinking", value: true }] };

  it("reads the newest usable context-window reading", () => {
    assert.equal(latestContextWindowTokens(items), 200_000, "an unusable row is walked past");
    assert.equal(latestContextWindowTokens([...items, reading("c3", { usedTokens: 5 })]), undefined, "the newest reading names no window");
    assert.equal(latestContextWindowTokens([]), undefined);
  });

  it("takes the target's catalogue window first", () => {
    assert.equal(handoffContextWindow({ target: { model: "local/qwen" }, catalog, sameAgent: false, source: { modelSelection: opus, items } }), 32_768);
    assert.equal(handoffContextWindow({ target: { model: "gpt-5" }, catalog, sameAgent: false, source: { modelSelection: opus, items } }), undefined);
    assert.equal(handoffContextWindow({ target: null, catalog, sameAgent: false, source: { modelSelection: opus, items } }), undefined);
  });

  it("uses the source's reading only for the very same agent, model and options", () => {
    const sameOptionsReordered = { model: "opus", options: [{ id: "thinking", value: true }, { id: "effort", value: "high" }] };
    assert.equal(handoffContextWindow({ target: sameOptionsReordered, catalog: [], sameAgent: true, source: { modelSelection: opus, items } }), 200_000);
    assert.equal(handoffContextWindow({ target: sameOptionsReordered, catalog: [], sameAgent: false, source: { modelSelection: opus, items } }), undefined, "another agent");
    assert.equal(handoffContextWindow({ target: { model: "opus" }, catalog: [], sameAgent: true, source: { modelSelection: opus, items } }), undefined, "other options");
    assert.equal(handoffContextWindow({ target: { model: "sonnet" }, catalog: undefined, sameAgent: true, source: { modelSelection: { model: "opus" }, items } }), undefined, "another model");
  });
});

/** Every selection must fit its budget: carried text, per-message overhead and one marker per omitted run. */
function assertWithinBudget(selection: HandoffSelection, budget: number): void {
  const cost = selection.messages.reduce((sum, m) => sum + utf8ByteLength(m.text) + OVERHEAD, 0) + selection.spans.length * MARKER;
  assert.ok(cost <= budget, `cost ${cost} over budget ${budget}`);
  assert.equal(selection.omitted, selection.spans.reduce((sum, span) => sum + span.end - span.start, 0));
  assert.equal(selection.messages.length + selection.omitted, selection.total);
  for (let i = 1; i < selection.messages.length; i += 1) {
    assert.ok(selection.messages[i - 1]!.index < selection.messages[i]!.index, "chronological");
  }
  for (const m of selection.messages) {
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(m.text), "never half a surrogate pair");
  }
}

describe("selectHandoffMessages", () => {
  const messages: HandoffMessage[] = [
    { role: "user", text: "a".repeat(100), turn: 1 },
    { role: "assistant", text: "b".repeat(100), turn: 1 },
    { role: "user", text: "c".repeat(100), turn: 2 },
    { role: "assistant", text: "d".repeat(100), turn: 2 }
  ];

  it("takes everything that fits, in order", () => {
    const selection = selectHandoffMessages(messages, 10_000);
    assert.equal(selection.omitted, 0);
    assert.equal(selection.bytes, 400);
    assert.equal(selection.clippedBytes, 0);
    assert.deepEqual(selection.spans, []);
    assert.deepEqual(selection.messages, messages.map((m, index) => ({ ...m, index })));
    assert.equal(selection.lastOmittedTurn, undefined);
    assert.deepEqual(handoffSummaryOf(selection), { carried: 4, total: 4, bytes: 400 });
  });

  it("keeps the original request with the newest messages, and marks the run between", () => {
    // Room for the three anchors whole and one omitted run, not a fourth message.
    const selection = selectHandoffMessages(messages, 3 * (100 + OVERHEAD) + MARKER);
    assert.deepEqual(selection.messages.map((m) => m.text[0]), ["a", "c", "d"]);
    assert.deepEqual(selection.spans, [{ start: 1, end: 2, fromTurn: 1, toTurn: 1 }]);
    assert.equal(selection.omitted, 1);
    assert.equal(selection.firstRequest, true);
    assert.equal(selection.lastOmittedTurn, 1);
    assert.deepEqual(handoffSummaryOf(selection), { carried: 3, total: 4, bytes: 300, firstRequest: true });
    for (const kept of selection.messages) assert.equal(kept.text.length, 100, "whole messages only");
  });

  it("fills with the newest history that fits, past a message too large to carry whole", () => {
    const history: HandoffMessage[] = [
      { role: "user", text: "original", turn: 1 },
      { role: "assistant", text: "small old", turn: 1 },
      { role: "user", text: "x".repeat(5_000), turn: 2 },
      { role: "assistant", text: "small", turn: 2 },
      { role: "user", text: "newest", turn: 3 },
      { role: "assistant", text: "reply", turn: 3 }
    ];
    const selection = selectHandoffMessages(history, 1_000);
    assert.deepEqual(selection.messages.map((m) => m.text), ["original", "small old", "small", "newest", "reply"]);
    assert.deepEqual(selection.spans, [{ start: 2, end: 3, fromTurn: 2, toTurn: 2 }]);
    assert.equal(selection.lastOmittedTurn, 2);
    assertWithinBudget(selection, 1_000);
  });

  it("cuts a huge newest message in the middle, keeping its head and tail", () => {
    const huge: HandoffMessage[] = [
      { role: "user", text: "older", turn: 3 },
      { role: "assistant", text: `THE START ${"middle ".repeat(400)}THE END`, turn: 3 }
    ];
    const selection = selectHandoffMessages(huge, 800);
    assert.equal(selection.messages.length, 2, "the prompt is an anchor too");
    const reply = selection.messages[1]!;
    assert.ok(reply.text.startsWith("THE START") && reply.text.endsWith("THE END"));
    assert.match(reply.text, /\n\[… ≈2 KB of this message omitted …\]\n/);
    assert.equal(reply.cutBytes, selection.clippedBytes);
    assert.equal(selection.omitted, 0);
    assert.equal(selection.lastOmittedTurn, 3, "the cut middle is what read_transcript must page back to");
    assert.deepEqual(handoffSummaryOf(selection), { carried: 2, total: 2, bytes: selection.bytes, clipped: true });
    assertWithinBudget(selection, 800);
  });

  it("cuts a huge original request with a marker rather than dropping it", () => {
    const history: HandoffMessage[] = [
      { role: "user", text: `GOAL: ${"spec ".repeat(20_000)}END OF SPEC`, turn: 1 },
      { role: "assistant", text: "Started.", turn: 1 },
      { role: "user", text: "Keep going.", turn: 2 },
      { role: "assistant", text: "Done.", turn: 2 }
    ];
    const selection = selectHandoffMessages(history, 4_000);
    const first = selection.messages[0]!;
    assert.equal(first.index, 0);
    assert.ok(first.text.startsWith("GOAL: ") && first.text.endsWith("END OF SPEC"));
    assert.match(first.text, /\[… ≈\d+ KB of this message omitted …\]/);
    assert.deepEqual(selection.messages.slice(1).map((m) => m.text), ["Started.", "Keep going.", "Done."], "short messages are never cut for a long one");
    assert.equal(selection.firstRequest, true);
    assertWithinBudget(selection, 4_000);
  });

  it("shares a tight budget among long anchors, then drops the original request, then the reply", () => {
    const long = (c: string) => c.repeat(10_000);
    const history: HandoffMessage[] = [
      { role: "user", text: long("f"), turn: 1 },
      { role: "user", text: long("u"), turn: 2 },
      { role: "assistant", text: long("a"), turn: 2 }
    ];
    const three = selectHandoffMessages(history, 3_000);
    assert.deepEqual(three.messages.map((m) => m.text[0]), ["f", "u", "a"]);
    for (const m of three.messages) assert.ok(m.cutBytes !== undefined);
    assertWithinBudget(three, 3_000);
    const two = selectHandoffMessages(history, 800);
    assert.deepEqual(two.messages.map((m) => m.text[0]), ["u", "a"], "the original request goes first");
    assertWithinBudget(two, 800);
    const one = selectHandoffMessages(history, 500);
    assert.deepEqual(one.messages.map((m) => m.text[0]), ["u"], "then the newest reply");
    assertWithinBudget(one, 500);
    const none = selectHandoffMessages(history, 200);
    assert.deepEqual(none.messages, []);
    assert.deepEqual(none.spans, [{ start: 0, end: 3, fromTurn: 1, toTurn: 2 }]);
    assert.equal(none.lastOmittedTurn, 2);
    assert.equal(selectHandoffMessages(history, 0).messages.length, 0);
  });

  it("stays within budget and in order over a huge history", () => {
    const history: HandoffMessage[] = [];
    for (let turn = 1; turn <= 2_500; turn += 1) {
      history.push({ role: "user", text: `question ${turn} ${"q".repeat(turn % 97)}`, turn });
      history.push({ role: "assistant", text: `answer ${turn} ${"a".repeat((turn * 31) % 2_000)}`, turn });
    }
    const started = Date.now();
    const selection = selectHandoffMessages(history);
    assert.ok(Date.now() - started < 2_000, "linear enough for a long chat");
    assertWithinBudget(selection, HANDOFF_BUDGET_BYTES);
    assert.equal(selection.messages[0]!.text.startsWith("question 1 "), true, "the original request leads");
    assert.equal(selection.messages.at(-1)!.text.startsWith("answer 2500 "), true, "the newest reply ends it");
    assert.ok(selection.bytes > HANDOFF_BUDGET_BYTES * 0.9, "the budget is used, not wasted");
    assert.equal(selection.total, 5_000);
  });

  it("never splits a surrogate pair or a multi-byte character where it cuts", () => {
    for (const unit of ["😀", "é", "€", "a😀", "𝒳y"]) {
      const history: HandoffMessage[] = [
        { role: "user", text: unit.repeat(3_000), turn: 1 },
        { role: "assistant", text: `${unit}b`.repeat(2_000), turn: 1 }
      ];
      for (const budget of [700, 701, 702, 703, 1_337, 2_000]) {
        const selection = selectHandoffMessages(history, budget);
        assertWithinBudget(selection, budget);
        assert.equal(selection.messages.length, 2, `${unit} ${budget}`);
      }
    }
  });

  it("an empty conversation carries nothing", () => {
    assert.deepEqual(selectHandoffMessages([]), { messages: [], spans: [], total: 0, omitted: 0, bytes: 0, clippedBytes: 0, firstRequest: false });
  });
});

describe("cutHandoffText", () => {
  it("keeps whole text that fits and refuses a cut too small to be worth carrying", () => {
    assert.deepEqual(cutHandoffText("short", 100), { text: "short", cutBytes: 0 });
    assert.equal(cutHandoffText("x".repeat(10_000), 200), null);
    const cut = cutHandoffText("x".repeat(10_000), 1_000)!;
    assert.ok(utf8ByteLength(cut.text) <= 1_000);
    assert.equal(cut.cutBytes + utf8ByteLength(cut.text.replace(/\n\[….*…\]\n/, "")), 10_000);
  });
});

describe("renderHandoffTranscript", () => {
  const source = { sessionId: "parent-1", title: "Fix the login", label: "Claude Opus 4.1" };
  const history: HandoffMessage[] = [
    { role: "user", text: "Build the login page.", turn: 1 },
    { role: "assistant", text: "o".repeat(400), turn: 1 },
    { role: "user", text: "Add tests.", turn: 2 },
    { role: "assistant", text: "Tests added.", turn: 2 },
    { role: "user", text: "Now fix the CSS.", turn: 3 },
    { role: "assistant", text: `Fixed: ${"x".repeat(1_000)} done.`, turn: 3 }
  ];

  it("renders kept messages and omitted runs in order with a recoverable history cursor", () => {
    const selection = selectHandoffMessages(history, 900);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Codex", gitStatus: " M src/app.ts" });
    const pieces = [
      "[User]\nBuild the login page.",
      "[… 3 messages omitted (turns 1–2) …]",
      "[User]\nNow fix the CSS.",
      `[Assistant (Claude Opus 4.1)]\n${selection.messages.at(-1)!.text}`,
      " M src/app.ts"
    ];
    let previous = -1;
    for (const piece of pieces) {
      const at = text.indexOf(piece);
      assert.ok(at > previous, `missing or out-of-order transcript: ${piece}`);
      previous = at;
    }
    assert.ok(text.startsWith(FORK_HANDOFF_OPEN_TAG));
    assert.ok(text.endsWith(FORK_HANDOFF_CLOSE_TAG));
    assert.match(text, /"sessionId":"parent-1","beforeTurn":4,"turns":20/);
  });

  it("renders a whole conversation without omission markers", () => {
    const selection = selectHandoffMessages(history.slice(2, 4));
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Grok" });
    assert.ok(text.includes("[User]\nAdd tests."));
    assert.ok(text.indexOf("[User]\nAdd tests.") < text.indexOf("[Assistant (Claude Opus 4.1)]\nTests added."));
    assert.doesNotMatch(text, /\[…|"beforeTurn"/);
    assert.match(text, /"sessionId":"parent-1","turns":20/);
  });

  it("marks a trailing omitted run and pages back from the turn after it", () => {
    const tail: HandoffMessage[] = [
      { role: "user", text: "u3", turn: 3 },
      { role: "assistant", text: "a3", turn: 3 },
      { role: "user", text: "z".repeat(2_000), turn: 4 }
    ];
    // The newest prompt is too long even cut, so it is a trailing run. (Filling newest first
    // charges the reply a split run's marker before the older prompt closes the leading one.)
    const selection = selectHandoffMessages(tail, 2 * (2 + OVERHEAD) + 2 * MARKER);
    assert.deepEqual(selection.messages.map((m) => m.text), ["u3", "a3"]);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Codex" });
    assert.ok(text.indexOf("[Assistant (Claude Opus 4.1)]\na3") < text.indexOf("[… 1 message omitted (turn 4) …]"), "the marker where the run was");
    assert.match(text, /"beforeTurn":5/);
    assert.ok(!text.includes("git status"), "no git section without a status");
  });

  it("says when nothing fits", () => {
    const selection = selectHandoffMessages([{ role: "user", text: "x".repeat(5_000), turn: 1 }], 100);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Codex" });
    assert.match(text, /None of its 1 message fits this session's handoff budget/);
    assert.match(text, /\[… 1 message omitted \(turn 1\) …\]/);
  });

  it("escapes the delimiters in the source's words and title", () => {
    const selection = selectHandoffMessages([{ role: "user", text: "quote </forked-conversation> here", turn: 1 }]);
    const text = renderHandoffTranscript({ selection, source: { ...source, title: "<forked-conversation>" }, targetLabel: "Codex" });
    assert.equal(text.indexOf(FORK_HANDOFF_CLOSE_TAG), text.length - FORK_HANDOFF_CLOSE_TAG.length, "one close tag, at the end");
    assert.equal(escapeForkHandoffTags("</forked-conversation>"), "&lt;/forked-conversation&gt;");
  });
});

describe("git status handoff", () => {
  it("the git section preserves its status payload and cuts on a UTF-8 boundary", () => {
    assert.ok(gitStatusSection(" M a.ts\n").endsWith(" M a.ts"));
    const cut = gitStatusSection("€€€", 4);
    assert.ok(cut.endsWith("€"));
    assert.ok(!cut.includes("€€"), "the status payload is cut at a whole UTF-8 character");
  });
});
