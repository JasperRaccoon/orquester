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
  buildThreadMessage,
  replyDeliveryContext,
  TOOLSET_CONTINUE_CONTEXT_KIND
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../lib/agent-chat/contracts";
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
      readDefaultMergeText: () => "B works",
      notice: null,
      onDismissNotice: () => undefined,
      onOpenSession: () => undefined,
      onMergeBack: async () => undefined,
      onMergeAction: async () => undefined
    })
  );

test("a fork's bar names its parent and offers Merge back", () => {
  const html = bar(fork, [parent, fork]);
  assert.match(html, /Plan the API/);
  assert.match(html, /Merge back/);
});

test("a child whose parent was closed says so, and offers no merge", () => {
  const html = bar(fork, [fork]);
  assert.doesNotMatch(html, /Merge back/);
});

test("a reply held after a stop is said quietly as held, with Deliver now — never as a failed merge", () => {
  const merge = { kind: "reply" as const, mergeId: "d-1", parentSessionId: "parent", childSessionId: "task", queuedAt: "t", preview: "Done", attempts: 0 };
  const held = { ...merge, state: "failed" as const, held: true as const, error: "Held because this chat was stopped: Deliver now to hand it over, or Discard it." };
  const html = bar(tab("parent", { title: "Plan the API", pendingMerges: [held] }), [parent, task]);
  assert.match(html, /Write tests/);
  assert.match(html, /held/);
  assert.match(html, /Deliver now/);
  assert.doesNotMatch(html, /failed:|Retry/);
  const refused = bar(tab("parent", { title: "Plan the API", pendingMerges: [{ ...merge, state: "failed" as const, error: "No." }] }), [parent, task]);
  assert.match(refused, /No\./);
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

test("Continue in another agent… sits beside the fork buttons, only where it is offered", () => {
  const offered = context({ onContinueIn: () => undefined });
  const user = render(createElement(UserMessageRow, { row: messageRow("user", "hi") as never }), offered);
  assert.match(user, /Continue in another agent from before this message…/);
  const meta = render(createElement(AssistantMetaRow, { row: messageRow("assistant", "hello", "assistant-meta") as never }), offered);
  assert.match(meta, /aria-label="Continue in another agent…"/);
  assert.match(meta, /aria-haspopup="dialog"/);
  const notOffered = render(createElement(AssistantMetaRow, { row: messageRow("assistant", "hello", "assistant-meta") as never }), context({}));
  assert.doesNotMatch(notOffered, /Continue in another agent/);
  const readOnly = render(
    createElement(UserMessageRow, { row: messageRow("user", "hi") as never }),
    context({ readOnly: true, onFork: null, onContinueIn: () => undefined })
  );
  assert.doesNotMatch(readOnly, /Continue in another agent/);
});

test("pending merges show on both tabs, with deliver and discard; a failed one says why", () => {
  const queued = { mergeId: "m1", parentSessionId: "parent", childSessionId: "fork", queuedAt: "t", state: "queued" as const, preview: "B works", attempts: 0 };
  const onFork = bar({ ...fork, pendingMerges: [queued] }, [parent, fork]);
  assert.match(onFork, /Plan the API/);
  assert.match(onFork, /queued/);
  assert.match(onFork, /Deliver now/);
  assert.match(onFork, /Discard/);
  const onParent = bar({ ...parent, pendingMerges: [{ ...queued, state: "failed", error: "refused: no", attempts: 3 }] }, [parent, fork]);
  assert.match(onParent, /refused: no/);
  assert.match(onParent, /Retry/);
  const retried = bar({ ...fork, pendingMerges: [{ ...queued, attempts: 1, error: "refused: compaction" }] }, [parent, fork]);
  assert.match(retried, /refused: compaction/, "a queued merge refused before says why");
});

// ---------------------------------------------------------------------------
// Unified MCP §4.1, §8.2: chats another chat's agent opened, and replies
// ---------------------------------------------------------------------------

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
  assert.match(html, /Codex review/);
  assert.match(html, /jaspersito\/orquester-3/);
  assert.match(html, />Another chat</);
  assert.match(html, /Looks good\./);
  assert.doesNotMatch(html, /\[Reply from/);
});

test("an older build's automatic continue is attributed to Orquester", () => {
  // As older builds wrote it after an approved request_toolset: old transcripts still render it as Orquester's.
  const continued = marked("[Orquester] The Workflow authoring tools are now available. Continue the task you were doing.", {
    kind: TOOLSET_CONTINUE_CONTEXT_KIND,
    label: "Orquester",
    ref: "workflow-authoring"
  });
  assert.match(continued, />Orquester</);
  assert.doesNotMatch(continued, />You</);
});
