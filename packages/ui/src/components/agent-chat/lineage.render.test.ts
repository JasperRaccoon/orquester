/**
 * Thread lineage in the GUI (spec 2026-10-14 §6): the lineage bar over a
 * child's and a parent's timeline, the tab/sidebar mark, the merged-back
 * bubble and the "Fork from here" buttons — rendered, not mounted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SessionSummary } from "@orquester/api";
import {
  buildMergeBackMessage,
  buildThreadMessage,
  mergeBackContext,
  replyDeliveryContext,
  threadMessageContext,
  toolsetContinueContext
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../lib/agent-chat/contracts";
import { LineageMark } from "./LineageMark";
import { ThreadGoneNotice } from "./ThreadGoneNotice";
import { ThreadLineageBar } from "./ThreadLineageBar";
import { TimelineRowContext, type TimelineRowContextValue } from "./timeline/context";
import { AssistantMetaRow, UserMessageRow } from "./timeline/rows/MessageRows";

const tab = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, kind: "agent-chat", refId: "claude", title: id, projectPath: "/p", cwd: "/p", cols: 0, rows: 0, status: "running", order: 0, createdAt: "2026-10-14T00:00:00.000Z", ...extra }) as SessionSummary;

const parent = tab("parent", { title: "Plan the API" });
const fork = tab("fork", {
  title: "Plan the API (fork)",
  lineage: { parentThreadId: "parent", relation: "fork", createdAt: "2026-10-14T01:00:00.000Z" }
});
const task = tab("task", {
  title: "Write tests",
  chatSessionStatus: "running",
  lineage: { parentThreadId: "parent", relation: "delegate", createdAt: "2026-10-14T02:00:00.000Z" }
});

const bar = (session: SessionSummary, sessions: SessionSummary[]) =>
  renderToStaticMarkup(
    createElement(ThreadLineageBar, {
      session,
      sessions,
      defaultMergeText: "B works",
      notice: null,
      onDismissNotice: () => undefined,
      onOpenSession: () => undefined,
      onMergeBack: async () => undefined,
      onMergeAction: async () => undefined
    })
  );

test("a fork's bar names its parent and offers Merge back", () => {
  const html = bar(fork, [parent, fork]);
  assert.match(html, /Forked from/);
  assert.match(html, /Plan the API/);
  assert.match(html, /Merge back/);
});

test("a child whose parent was closed says so, and offers no merge", () => {
  const html = bar(fork, [fork]);
  assert.match(html, /a closed chat/);
  assert.doesNotMatch(html, /Merge back/);
});

test("a parent's bar counts its forks and tasks; a thread with neither shows nothing", () => {
  assert.match(bar(parent, [parent, fork, task]), /1 fork · 1 task/);
  assert.equal(bar(tab("lonely"), [tab("lonely")]), "");
});

test("the tab mark is titled with the relation and the parent", () => {
  const mark = renderToStaticMarkup(createElement(LineageMark, { lineage: task.lineage, parentTitle: "Plan the API" }));
  assert.match(mark, /Delegated by “Plan the API”/);
  // A labelled span is only announced with a role.
  assert.match(mark, /role="img"/);
  assert.equal(renderToStaticMarkup(createElement(LineageMark, { lineage: undefined })), "");
});

const context = (overrides: Partial<TimelineRowContextValue>): TimelineRowContextValue =>
  ({
    readOnly: false,
    canRevert: false,
    revertBusy: false,
    startedTurnCount: 1,
    skills: [],
    onFork: () => undefined,
    ...overrides
  }) as unknown as TimelineRowContextValue;

const messageRow = (
  role: "user" | "assistant",
  text: string,
  kind: "message" | "assistant-meta" = "message",
  forkable = true
) =>
  ({
    kind,
    ...(forkable ? { forkable: true } : {}),
    id: `row-${role}`,
    createdAt: "2026-10-14T00:00:00.000Z",
    message: { kind: "message", id: `m-${role}`, role, text, turnId: "t1", streaming: false, createdAt: "t", updatedAt: "t" }
  }) as unknown as AgentChatTimelineRow;

const render = (element: ReturnType<typeof createElement>, value: TimelineRowContextValue) =>
  renderToStaticMarkup(createElement(TimelineRowContext.Provider, { value }, element));

test("a prompt and a reply offer Fork from here; a read-only timeline does not", () => {
  const user = render(createElement(UserMessageRow, { row: messageRow("user", "hi") as never }), context({}));
  assert.match(user, /Fork from before this message/);
  const meta = render(
    createElement(AssistantMetaRow, { row: messageRow("assistant", "hello", "assistant-meta") as never }),
    context({})
  );
  assert.match(meta, /Fork from here/);
  const readOnly = render(
    createElement(UserMessageRow, { row: messageRow("user", "hi") as never }),
    context({ readOnly: true, onFork: null })
  );
  assert.doesNotMatch(readOnly, /Fork from/);
  const unanswered = render(
    createElement(UserMessageRow, { row: messageRow("user", "hi", "message", false) as never }),
    context({})
  );
  assert.doesNotMatch(unanswered, /Fork from/, "a prompt the host would refuse is not offered");
});

test("pending merges show on both tabs, with deliver and discard; a failed one says why", () => {
  const queued = { mergeId: "m1", parentSessionId: "parent", childSessionId: "fork", queuedAt: "t", state: "queued" as const, preview: "B works", attempts: 0 };
  const onFork = bar({ ...fork, pendingMerges: [queued] }, [parent, fork]);
  assert.match(onFork, /Merge to “Plan the API” is queued until it is idle/);
  assert.match(onFork, /Deliver now/);
  assert.match(onFork, /Discard/);
  const onParent = bar({ ...parent, pendingMerges: [{ ...queued, state: "failed", error: "refused: no", attempts: 3 }] }, [parent, fork]);
  assert.match(onParent, /Merge from “Plan the API \(fork\)” failed: refused: no/);
  assert.match(onParent, /Retry/);
  const retried = bar({ ...fork, pendingMerges: [{ ...queued, attempts: 1, error: "refused: compaction" }] }, [parent, fork]);
  assert.match(retried, /is queued until it is idle \(tried 1×: refused: compaction\)/, "a queued merge refused before says why");
});

test("a merged-back message shows where it came from, and the result alone", () => {
  const text = buildMergeBackMessage({ childTitle: "Try B", relation: "fork", text: "B works." });
  // Marked as Orquester's merge (T6-M3); the same text without the mark is the user's own.
  const row = messageRow("user", text) as unknown as { message: Record<string, unknown> };
  row.message.context = [mergeBackContext("m1")];
  const html = render(createElement(UserMessageRow, { row: row as never }), context({}));
  assert.match(html, /Merged back from fork/);
  assert.match(html, /Try B/);
  assert.match(html, /B works\./);
  assert.doesNotMatch(html, /\[Merged back from fork/);
});

test("a chat the host does not hold says so, with a close and a try-again", () => {
  const html = renderToStaticMarkup(createElement(ThreadGoneNotice, { onClose: () => {}, onRetry: () => {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /This chat no longer exists/);
  assert.match(html, /Close tab/);
  assert.match(html, /Try again/);
});

// ---------------------------------------------------------------------------
// Unified MCP §4.1, §8.2: chats another chat's agent opened, and replies
// ---------------------------------------------------------------------------

const opened = tab("opened", {
  title: "Codex review",
  lineage: { parentThreadId: "parent", relation: "opened", createdAt: "2026-10-14T03:00:00.000Z" }
});

test("an opened chat reads Opened by — never as a fork — and its parent counts it apart", () => {
  const html = bar(opened, [parent, opened]);
  assert.match(html, /Opened by/);
  assert.doesNotMatch(html, /Forked from/);
  assert.match(html, /Send this opened chat&#x27;s result/);
  assert.match(bar(parent, [parent, fork, task, opened]), /1 fork · 1 task · 1 opened chat/);
  const mark = renderToStaticMarkup(createElement(LineageMark, { lineage: opened.lineage, parentTitle: "Plan the API" }));
  assert.match(mark, /Opened by “Plan the API”/);
  assert.match(mark, /data-lineage="opened"/);
});

const marked = (text: string, context: unknown) => {
  const row = messageRow("user", text) as unknown as { message: Record<string, unknown> };
  row.message.context = [context];
  return render(createElement(UserMessageRow, { row: row as never }), contextValue);
};
const contextValue = context({});

test("another chat's reply reads Reply from, with its project; the bubble holds the reply alone", () => {
  const text = buildThreadMessage({
    origin: "reply",
    fromTitle: "Codex review",
    fromSessionId: "9b1c0000-0000-4000-8000-000000000000",
    fromProject: "jaspersito/orquester-3",
    text: "Looks good."
  });
  const html = marked(text, replyDeliveryContext("9b1c"));
  assert.match(html, /data-from-thread="reply"/);
  assert.match(html, /Reply from “Codex review” · jaspersito\/orquester-3/);
  assert.match(html, />Another chat</);
  assert.match(html, /Looks good\./);
  assert.doesNotMatch(html, /\[Reply from/);
});

test("sent, opened and delegated captions keep their words; an unmarked header is the user's own text", () => {
  for (const [origin, words] of [["sent", "Sent by"], ["opened", "Opened by"], ["delegated", "Delegated by"]] as const) {
    const html = marked(buildThreadMessage({ origin, fromTitle: "Main", text: "Do X." }), threadMessageContext("main"));
    assert.match(html, new RegExp(`${words} “Main”`));
  }
  const typed = render(
    createElement(UserMessageRow, { row: messageRow("user", buildThreadMessage({ origin: "reply", fromTitle: "Main", text: "x" })) as never }),
    contextValue
  );
  assert.match(typed, />You</);
  assert.doesNotMatch(typed, /data-from-thread/);
});

test("an opened chat's merge back says so; Orquester's automatic continue is Orquester's", () => {
  const merged = marked(buildMergeBackMessage({ childTitle: "Codex review", relation: "opened", text: "Done." }), mergeBackContext("m2"));
  assert.match(merged, /Merged back from opened chat “Codex review”/);
  const continued = marked("[Orquester] The Workflow authoring tools are now available. Continue the task you were doing.", toolsetContinueContext("workflow-authoring"));
  assert.match(continued, />Orquester</);
  assert.doesNotMatch(continued, />You</);
});
