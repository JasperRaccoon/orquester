import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compactPreviewText,
  delegateAttentionContext,
  delegateAttentionNoticeText,
  delegatePreviewOf,
  parseDelegateView,
  parseInterruptCause
} from "./delegation.ts";
import type { ThreadItem, Turn } from "./thread.ts";
import { buildThreadMessage, isThreadAuthoredMessage, parseThreadMessage, THREAD_MESSAGE_OVERHEAD_CHARS } from "./thread-tools.ts";

const turn = (turnId: string, state: Turn["state"], extra: Partial<Turn> = {}): Turn => ({
  turnId,
  state,
  turnCount: null,
  requestedAt: "2026-10-20T10:00:00.000Z",
  startedAt: "2026-10-20T10:00:01.000Z",
  completedAt: state === "running" ? null : "2026-10-20T10:00:09.000Z",
  assistantMessageId: null,
  ...extra
});

const say = (id: string, role: "user" | "assistant", text: string, turnId: string | null, extra: Record<string, unknown> = {}): ThreadItem =>
  ({ kind: "message", id, role, text, turnId, streaming: false, createdAt: "t", updatedAt: `u-${id}`, ...extra }) as ThreadItem;

const tool = (id: string, summary: string, turnId: string, extra: Record<string, unknown> = {}): ThreadItem =>
  ({ kind: "activity", id, tone: "tool", activityKind: "tool.completed", summary, payload: {}, turnId, createdAt: "t", updatedAt: `u-${id}`, ...extra }) as ThreadItem;

describe("a delegated child's preview", () => {
  it("is the settled turn's answer, else its error", () => {
    const items = [say("u1", "user", "Do it", "t1"), say("a1", "assistant", "All  done:\n\n- three files", "t1")];
    assert.deepEqual(delegatePreviewOf(items, [turn("t1", "completed")]), { kind: "result", text: "All done: - three files", at: "2026-10-20T10:00:09.000Z" });
    assert.deepEqual(delegatePreviewOf([], [turn("t1", "failed", { errorMessage: "quota exceeded" })])?.text, "quota exceeded");
    assert.equal(delegatePreviewOf([], [turn("t1", "interrupted")]), null);
    assert.equal(delegatePreviewOf([], []), null);
  });

  it("is the running turn's latest word or tool row — never a subagent's, never an earlier turn's", () => {
    const items = [
      say("a0", "assistant", "old answer", "t0"),
      say("u1", "user", "Go", "t1"),
      say("a1", "assistant", "Reading the parser first.", "t1"),
      tool("x1", "Ran pnpm test", "t1"),
      say("s1", "assistant", "subagent chatter", "t1", { agentId: "sub" })
    ];
    assert.deepEqual(delegatePreviewOf(items, [turn("t0", "completed"), turn("t1", "running")]), { kind: "progress", text: "Ran pnpm test", at: "u-x1" });
    // Nothing of the running turn yet: no preview (the old turn's answer is not this turn's word).
    assert.equal(delegatePreviewOf(items.slice(0, 2), [turn("t0", "completed"), turn("t1", "running")]), null);
  });

  it("cuts to the preview length on one line", () => {
    const cut = compactPreviewText(`${"a".repeat(400)} end`);
    assert.equal(cut.length, 280);
    assert.ok(cut.endsWith("…"));
    assert.equal(compactPreviewText("  short \n text "), "short text");
    assert.equal(compactPreviewText("   "), "");
  });

  it("reads a view off the wire field-wise", () => {
    assert.deepEqual(parseDelegateView({ model: "gpt-5", preview: { kind: "progress", text: "x", at: "t" } }), {
      model: "gpt-5",
      preview: { kind: "progress", text: "x", at: "t" }
    });
    assert.deepEqual(parseDelegateView({ model: 7, preview: { kind: "other", text: "x", at: "t" } }), { model: null, preview: null });
    assert.equal(parseDelegateView("nope"), undefined);
  });
});

describe("the stop cascade's cause", () => {
  it("reads field-wise and drops anything that is not one", () => {
    assert.deepEqual(parseInterruptCause({ kind: "parent-stopped", parentSessionId: "p", parentTitle: " Main\nchat ", action: "closed" }), {
      kind: "parent-stopped",
      parentSessionId: "p",
      parentTitle: "Main chat",
      action: "closed"
    });
    assert.equal(parseInterruptCause({ kind: "parent-stopped", parentSessionId: "p", action: "exploded" }), undefined);
    assert.equal(parseInterruptCause({ kind: "other", parentSessionId: "p", action: "closed" }), undefined);
    assert.equal(parseInterruptCause(null), undefined);
  });
});

describe("the attention notice", () => {
  it("names the child, quotes the request and says what the parent can do", () => {
    const question = delegateAttentionNoticeText({ title: "Task: docs", sessionId: "c1", requestId: "q1", kind: "question", quote: "Which\nformat?" });
    assert.ok(question.includes('"Task: docs"'));
    assert.ok(question.includes('"Which format?"'));
    assert.match(question, /respond_to_request \{sessionId: "c1", requestId: "q1"/);
    const approval = delegateAttentionNoticeText({ title: "Task: docs", sessionId: "c1", requestId: "a1", kind: "approval", quote: "rm -rf build" });
    assert.ok(approval.includes("rm -rf build"));
    assert.doesNotMatch(approval, /respond_to_request/, "an approval is a person's to decide");
    const secret = delegateAttentionNoticeText({ title: "Task: docs", sessionId: "c1", requestId: "secret:s1", kind: "secret", quote: "GITHUB_TOKEN" });
    assert.ok(secret.includes("GITHUB_TOKEN"));
    const long = delegateAttentionNoticeText({ title: "T", sessionId: "c1", requestId: "q", kind: "question", quote: "x".repeat(2_000) });
    assert.ok(long.length < 1_000, "the quote is cut short");
  });

  it("rides an attention header that parses back, with a thread-authored chip", () => {
    const input = buildThreadMessage({ origin: "attention", fromTitle: "Task: docs", fromSessionId: "c1", fromProject: "ws/p", text: "Blocked." });
    const parsed = parseThreadMessage(input);
    assert.equal(parsed?.origin, "attention");
    assert.equal(parsed?.fromTitle, "Task: docs");
    assert.equal(parsed?.fromSessionId, "c1");
    assert.equal(parsed?.body, "Blocked.");
    assert.ok(input.length - "Blocked.".length <= THREAD_MESSAGE_OVERHEAD_CHARS);
    assert.ok(isThreadAuthoredMessage({ context: [delegateAttentionContext("c1")] }));
  });
});
