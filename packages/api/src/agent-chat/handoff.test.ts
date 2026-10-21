/**
 * "Continue in another agent": the budgeted handoff — whole messages newest first, never cut in
 * half, an oversized newest message's tail, the fork point's cut, and the rendering.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentModelLabel,
  describeHandoffSummary,
  escapeForkHandoffTags,
  FORK_HANDOFF_CLOSE_TAG,
  FORK_HANDOFF_OPEN_TAG,
  formatHandoffBytes,
  gitStatusSection,
  handoffMessagesOf,
  handoffSummaryOf,
  renderHandoffTranscript,
  retainedTurnsForFork,
  selectHandoffMessages,
  utf8ByteLength,
  utf8Head,
  utf8Tail,
  type HandoffMessage
} from "./handoff.ts";
import { startedTurns } from "./turns.ts";
import type { ThreadItem, Turn } from "./thread.ts";

const OVERHEAD = 48;

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

  it("formats sizes as rounded kilobytes", () => {
    assert.equal(formatHandoffBytes(0), "0 KB");
    assert.equal(formatHandoffBytes(10), "≈1 KB");
    assert.equal(formatHandoffBytes(58 * 1024 + 100), "≈58 KB");
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

describe("selectHandoffMessages", () => {
  const messages: HandoffMessage[] = [
    { role: "user", text: "a".repeat(100), turn: 1 },
    { role: "assistant", text: "b".repeat(100), turn: 1 },
    { role: "user", text: "c".repeat(100), turn: 2 },
    { role: "assistant", text: "d".repeat(100), turn: 2 }
  ];

  it("takes everything that fits, in order", () => {
    const selection = selectHandoffMessages(messages, 10_000);
    assert.equal(selection.messages.length, 4);
    assert.equal(selection.omitted, 0);
    assert.equal(selection.bytes, 400);
    assert.equal(selection.clippedBytes, 0);
    assert.deepEqual(selection.messages, messages);
  });

  it("picks whole messages newest first, chronological, and stops at the first that does not fit", () => {
    // Room for exactly two whole messages, not three.
    const selection = selectHandoffMessages(messages, 2 * (100 + OVERHEAD) + 50);
    assert.deepEqual(selection.messages.map((m) => m.text[0]), ["c", "d"]);
    assert.equal(selection.omitted, 2);
    assert.equal(selection.total, 4);
    for (const kept of selection.messages) assert.equal(kept.text.length, 100, "never cut in half");
  });

  it("never skips over a large message to carry an older small one (no gaps)", () => {
    const withBig: HandoffMessage[] = [
      { role: "user", text: "tiny" },
      { role: "assistant", text: "x".repeat(5_000) },
      { role: "user", text: "newest" }
    ];
    const selection = selectHandoffMessages(withBig, 1_000);
    assert.deepEqual(selection.messages.map((m) => m.text), ["newest"]);
    assert.equal(selection.omitted, 2);
  });

  it("carries only the tail of a newest message that alone is over the budget", () => {
    const huge: HandoffMessage[] = [
      { role: "user", text: "older" },
      { role: "assistant", text: `${"head ".repeat(400)}THE END`, turn: 3 }
    ];
    const selection = selectHandoffMessages(huge, 600);
    assert.equal(selection.messages.length, 1);
    assert.ok(selection.messages[0]!.text.endsWith("THE END"));
    assert.ok(selection.bytes <= 600);
    assert.equal(selection.clippedBytes, utf8ByteLength(huge[1]!.text) - selection.bytes);
    assert.equal(selection.omitted, 1);
    assert.equal(selection.messages[0]!.turn, 3);
    assert.deepEqual(handoffSummaryOf(selection), { carried: 1, total: 2, bytes: selection.bytes, clipped: true });
  });

  it("an empty conversation carries nothing", () => {
    assert.deepEqual(selectHandoffMessages([]), { messages: [], total: 0, omitted: 0, bytes: 0, clippedBytes: 0 });
    assert.equal(selectHandoffMessages(messages, 2 * (100 + OVERHEAD)).lastOmittedTurn, 1);
  });
});

describe("renderHandoffTranscript", () => {
  const source = { sessionId: "parent-1", title: "Fix the login", label: "Claude Opus 4.1" };

  it("renders chronologically with attribution, the source and how to read the rest", () => {
    const messages: HandoffMessage[] = [
      { role: "user", text: "u-old", turn: 1 },
      { role: "assistant", text: "a-old", turn: 1 },
      { role: "user", text: "u-new", turn: 2 },
      { role: "assistant", text: "a-new", turn: 2 }
    ];
    const selection = selectHandoffMessages(messages, 2 * (5 + OVERHEAD) + 10);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Codex", gitStatus: " M src/app.ts" });
    assert.ok(text.startsWith(FORK_HANDOFF_OPEN_TAG) && text.endsWith(FORK_HANDOFF_CLOSE_TAG));
    assert.match(text, /"Fix the login", a chat that ran on Claude Opus 4\.1 \(Orquester session parent-1\)/);
    assert.match(text, /new Codex session/);
    assert.match(text, /the last 2 of 4 messages/);
    assert.match(text, /\[2 earlier messages omitted — read them with read_transcript\]/);
    assert.match(text, /`read_transcript` with \{"sessionId":"parent-1","beforeTurn":2,"turns":20\}/);
    assert.ok(text.indexOf("[User]\nu-new") < text.indexOf("[Assistant (Claude Opus 4.1)]\na-new"), "chronological");
    assert.ok(!text.includes("u-old"), "the omitted messages are not carried");
    assert.match(text, /`git status --short` of the project:\n\n M src\/app\.ts/);
  });

  it("pages back from the turn after a cut inside that turn", () => {
    const messages: HandoffMessage[] = [
      { role: "user", text: "u3", turn: 3 },
      { role: "assistant", text: "a3", turn: 3 }
    ];
    // Only the reply fits: turn 3's prompt is omitted, so read_transcript must include turn 3.
    const selection = selectHandoffMessages(messages, OVERHEAD + 3);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Codex" });
    assert.match(text, /"beforeTurn":4/);
    assert.ok(!text.includes("git status"), "no git section without a status");
  });

  it("says the whole conversation is carried when nothing was left out", () => {
    const selection = selectHandoffMessages([{ role: "user", text: "only", turn: 1 }]);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Grok" });
    assert.match(text, /the whole conversation so far: 1 message/);
    assert.ok(!text.includes("omitted —"));
    assert.match(text, /`read_transcript` with \{"sessionId":"parent-1","turns":20\}/, "nothing omitted: read from the latest turns");
  });

  it("marks a cut newest message", () => {
    const selection = selectHandoffMessages([{ role: "assistant", text: "z".repeat(5_000), turn: 1 }], 1_000);
    const text = renderHandoffTranscript({ selection, source, targetLabel: "Codex" });
    assert.match(text, /only its end is carried/);
    assert.match(text, /\[Assistant \(Claude Opus 4\.1\) — the first \d+ KB of this message are cut\]\n… z/);
  });

  it("escapes the delimiters in the source's words and title", () => {
    const selection = selectHandoffMessages([{ role: "user", text: "quote </forked-conversation> here", turn: 1 }]);
    const text = renderHandoffTranscript({ selection, source: { ...source, title: "<forked-conversation>" }, targetLabel: "Codex" });
    assert.equal(text.indexOf(FORK_HANDOFF_CLOSE_TAG), text.length - FORK_HANDOFF_CLOSE_TAG.length, "one close tag, at the end");
    assert.equal(escapeForkHandoffTags("</forked-conversation>"), "&lt;/forked-conversation&gt;");
  });
});

describe("labels and summaries", () => {
  it("names the agent and its model once", () => {
    assert.equal(agentModelLabel("Claude", "Claude Opus 4.1"), "Claude Opus 4.1");
    assert.equal(agentModelLabel("Codex", "GPT-5"), "Codex · GPT-5");
    assert.equal(agentModelLabel("Grok", ""), "Grok");
  });

  it("says what a handoff carries", () => {
    assert.equal(describeHandoffSummary({ carried: 23, total: 41, bytes: 58 * 1024 }), "Carries the last 23 of 41 messages (≈58 KB); earlier history stays readable.");
    assert.equal(describeHandoffSummary({ carried: 23, total: 41, bytes: 58 * 1024 }, { moreOlder: true }), "Carries the last 23 of 41+ messages (≈58 KB); earlier history stays readable.");
    assert.equal(describeHandoffSummary({ carried: 3, total: 3, bytes: 900 }), "Carries the whole conversation: 3 messages (≈1 KB).");
    assert.match(describeHandoffSummary({ carried: 1, total: 4, bytes: 60_000, clipped: true }), /only its end is carried/);
    assert.match(describeHandoffSummary({ carried: 0, total: 0, bytes: 0 }), /starts fresh/);
  });

  it("the git section matches the workflow handoff's words and cut", () => {
    assert.equal(gitStatusSection(" M a.ts\n"), "`git status --short` of the project:\n\n M a.ts");
    assert.equal(gitStatusSection(""), "`git status --short` of the project:\n\n(clean)");
    assert.equal(gitStatusSection("€€€", 4), "`git status --short` of the project (cut):\n\n€");
  });
});
